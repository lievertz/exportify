// A collection of functions to create and send API queries
const utils = {
	// Send a request to the Spotify server to let it know we want a session. This is literally accomplished by navigating
	// to a web address, which accomplishes a GET, with correct query params in tow. There the user may have to enter their
	// Spotify credentials, after which they are redirected. Which client app wants access, which information exactly it wants
	// access to (https://developer.spotify.com/documentation/web-api/concepts/scopes), where to redirect, etc. constitute the
	// params. Since we now have to do https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow, this
	// accomplishes only the first phase. Essentially we generate a random secret then hash and encode it and send the hashed
	// side (the "challenge") to the authorization server in the original GET. The server responds with a code, which we send
	// back along with the secret (the "verifier") in a POST form, which proves the original request came from the same origin.
	// The auth code is finally sent in the response body to that latter request, instead of as a plaintext url param.
	// https://developer.spotify.com/documentation/web-api/concepts/authorization
	async authorize() { // This is bound to the login button in the HTML and gets called when the login button is clicked.
		let alphanumeric = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
		let code_verifier = crypto.getRandomValues(new Uint8Array(64)).reduce((acc, x) => acc + alphanumeric[x % alphanumeric.length], "")
		let hashed = await crypto.subtle.digest('SHA-256', (new TextEncoder()).encode(code_verifier)) // some crypto methods are async
		let code_challenge = btoa(String.fromCharCode(...new Uint8Array(hashed))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

		localStorage.setItem('code_verifier', code_verifier) // save the random string secret
		// client_id can be overridden via config.local.js (see config.local.example.js); default is the production app's id
		let client_id = (typeof window !== 'undefined' && window.CONFIG?.spotify_client_id) || "d99b082b01d74d61a100c9a0e056380b"
		location = "https://accounts.spotify.com/authorize?client_id=" + client_id +
			"&redirect_uri=" + encodeURIComponent(location.origin) +
			"&scope=playlist-read-private%20playlist-read-collaborative%20user-library-read" + // access to particular scopes of info defined here
			"&response_type=code&code_challenge_method=S256&code_challenge=" + code_challenge
	},

	// Make an asynchronous call to the server. Promises are *weird*. Careful here! You have to call .json() on the
	// Promise returned by the fetch to get a second Promise that has the actual data in it!
	// https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch
	// https://eloquentjavascript.net/11_async.html
	async apiCall(url, delay=0, bad_gateway_retries=2) {
		await new Promise(r => setTimeout(r, delay)) // JavaScript equivalent of sleep(delay), to stay under rate limits ;)
		let response = await fetch(url, { headers: { 'Authorization': 'Bearer ' + localStorage.getItem('access_token')} })
		if (response.ok) { return response.json() }
		else if (response.status == 401) { location = location.href.split('#')[0] } // Return to home page after auth token expiry
		else if (response.status == 429) {
			//if (!error.innerHTML.includes("fa-bolt")) { error.innerHTML += '<p><i class="fa fa-bolt" style="font-size: 50px; margin-bottom: 20px">\
			//	</i></p><p>Exportify has encountered <a target="_blank" href="https://developer.spotify.com/documentation/web-api/concepts/rate-limits">\
			//	rate limiting</a> while querying endpoint ' + url.split('?')[0] + '!<br/>Don\'t worry: Automatic backoff is implemented, and your data is \
			//	still downloading. But <a href="https://github.com/pavelkomarov/exportify/issues">I would be interested to hear about this.</a></p><br/>' }
			return utils.apiCall(url, response.headers.get('Retry-After')*1000) } // API Rate-limiting encountered, so tail-call replacement request on a delay
		else if (response.status == 502 && bad_gateway_retries > 0) {
			if (!error.innerHTML.includes("fa-bolt")) { error.innerHTML += '<p><i class="fa fa-bolt" style="font-size: 50px; margin-bottom: 20px">\
				</i></p><p>Exportify has encountered a <a target="_blank" href="https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/502">\
				bad gateway</a> while querying endpoint ' + url.split('?')[0] + '!<br/>Retries are implemented, so your download may still succeed. \
				But <a href="https://github.com/pavelkomarov/exportify/issues">I would be interested to hear about this.</a></p><br/>' }
            return utils.apiCall(url, (3-bad_gateway_retries)*1000, bad_gateway_retries-1) }
		else { error.innerHTML = "The server returned an HTTP " + response.status + " response.<br/>" } // the caller will fail
	},

	// Logging out of Spotify is much like logging in: You have to navigate to a certain url. But unlike logging in, there is
	// no way to redirect back to my home page. So open the logout page in a new tab, then redirect to the homepage after a
	// second, which is almost always long enough for the logout request to go through. Scratch that: just wipe data and reload page.
	logout() {
		localStorage.clear() // otherwise when the page is reloaded it still just finds and uses the access_token
		location = location.origin //let logout = open("https://www.spotify.com/logout"); setTimeout(() => {logout.close(); location = location.origin}, 1000)
	}
}

// =====================================================================================
// Enrichment: Spotify deprecated audio-features (and analysis, recommendations, related
// artists, featured playlists) for new client apps in November 2024, so we pull
// replacement data from third-party services keyed off the ISRC code each Spotify track
// carries. Each service gets its own queue with conservative pacing and a circuit
// breaker: if 5 calls in a row fail with anything other than a clean miss, we assume
// something is structurally wrong (URL shape, service down, IP blocked) rather than
// sporadic, and stop trying for that service. The other services keep going.
// Note: browsers refuse to let JS override the User-Agent header, so requests go out
// with the regular browser UA — which is exactly what the user asked for ("safe,
// browser-like"). We honor each service's rate-limit guidance via minIntervalMs.
// =====================================================================================
const enrich = {
	// Default transport: standard fetch, wrapping the Response in a shape the queue understands.
	async fetchTransport(url, options) {
		let r = await fetch(url, options)
		return { ok: r.ok, status: r.status, retryAfter: parseInt(r.headers.get('Retry-After') || '0', 10), json: () => r.json() }
	},

	// JSONP transport: needed for services like Deezer that don't send Access-Control-Allow-Origin
	// on their public API. We inject a <script> tag with a callback param; the response is JS that
	// invokes our callback with the data. Bypasses CORS because <script> tags aren't same-origin
	// restricted. No status codes available, so any failure (load error or timeout) just throws.
	jsonpTransport(url) {
		return new Promise((resolve, reject) => {
			let cbName = 'exportify_jsonp_' + Math.random().toString(36).slice(2)
			let script = document.createElement('script')
			let cleanup = () => { try { delete window[cbName] } catch (_) {}; script.remove() }
			let timer = setTimeout(() => { cleanup(); reject(new Error('JSONP timeout')) }, 15000)
			window[cbName] = data => { clearTimeout(timer); cleanup()
				resolve({ ok: true, status: 200, retryAfter: 0, json: () => Promise.resolve(data) }) }
			script.onerror = () => { clearTimeout(timer); cleanup(); reject(new Error('JSONP load failed')) }
			script.src = url + (url.includes('?') ? '&' : '?') + 'output=jsonp&callback=' + cbName
			document.head.appendChild(script)
		})
	},

	makeQueue({ name, minIntervalMs, maxConsecutiveFailures = 5, maxRetries = 2, transport }) {
		transport = transport || enrich.fetchTransport
		let lastStart = 0
		let consecutiveFailures = 0
		let aborted = false

		async function paced() {
			let wait = Math.max(0, lastStart + minIntervalMs - Date.now())
			if (wait > 0) await new Promise(r => setTimeout(r, wait))
			lastStart = Date.now()
		}

		return {
			name,
			get aborted() { return aborted },
			async call(url, options = {}) {
				if (aborted) return null
				await paced()
				for (let attempt = 0; attempt <= maxRetries; attempt++) {
					let response, err
					try { response = await transport(url, options) }
					catch (e) { err = e } // network-level / CORS / JSONP load failure

					if (response?.ok) { consecutiveFailures = 0; return response.json() }
					if (response?.status === 404) { consecutiveFailures = 0; return null } // clean miss; not a failure
					if (response?.status === 429) { // honor service's retry-after on rate limit
						await new Promise(r => setTimeout(r, (response.retryAfter || 2) * 1000))
						continue
					}
					if (attempt < maxRetries) { // sporadic failure: backoff and retry
						await new Promise(r => setTimeout(r, 500 * (attempt + 1)))
						continue
					}
					// exhausted retries -> count as a real failure for the circuit breaker
					consecutiveFailures++
					if (consecutiveFailures >= maxConsecutiveFailures) {
						aborted = true
						let detail = err ? err.message : 'HTTP ' + (response?.status ?? 'unknown')
						enrich.warn(name + ' enrichment aborted after ' + consecutiveFailures +
							' consecutive failures (last: ' + detail + '). Other columns still export.')
					}
					return null
				}
			},
		}
	},

	warn(msg) {
		error.innerHTML += '<p><i class="fa fa-exclamation-triangle" style="font-size: 20px; margin-right: 8px"></i>' + msg + '</p>'
	},

	// Deezer's /track/isrc:<isrc> endpoint doesn't send Access-Control-Allow-Origin on responses,
	// so plain fetch fails CORS. We use JSONP via <script> injection instead, which sidesteps
	// CORS entirely. Misses come back as HTTP 200 with {error:{code:800}}, so we sniff the body
	// rather than rely on status codes.
	async deezer(isrcs, setStatus) {
		if (isrcs.length === 0) return {}
		let q = enrich.makeQueue({ name: 'Deezer', minIntervalMs: 150, transport: enrich.jsonpTransport })
		let out = {}
		let i = 0
		for (let isrc of isrcs) {
			if (q.aborted) break
			setStatus?.('Deezer ' + (++i) + '/' + isrcs.length)
			let d = await q.call('https://api.deezer.com/track/isrc:' + encodeURIComponent(isrc))
			if (d && !d.error) out[isrc] = { bpm: d.bpm, gain: d.gain }
		}
		return out
	},

	// MusicBrainz asks for ≤1 req/sec. We resolve ISRC → recording, then pluck the first
	// recording and its tags/genres. The recording's MBID is what feeds AcousticBrainz.
	async musicbrainz(isrcs, setStatus) {
		if (isrcs.length === 0) return {}
		let q = enrich.makeQueue({ name: 'MusicBrainz', minIntervalMs: 1100 })
		let out = {}
		let i = 0
		for (let isrc of isrcs) {
			if (q.aborted) break
			setStatus?.('MusicBrainz ' + (++i) + '/' + isrcs.length)
			// `genres` is not a valid inc parameter on the /isrc/ endpoint (returns 400) — only `tags` is.
			let data = await q.call('https://musicbrainz.org/ws/2/isrc/' + encodeURIComponent(isrc) + '?inc=tags&fmt=json',
				{ headers: { 'Accept': 'application/json' } })
			if (data?.recordings?.length > 0) {
				let r = data.recordings[0] // first recording match; multiple MBIDs can share an ISRC across releases
				let tagNames = (r.tags || []).sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 5).map(t => t.name)
				out[isrc] = { mbid: r.id, tags: tagNames.join(';') }
			}
		}
		return out
	},

	// AcousticBrainz supports bulk lookup of up to 25 MBIDs at a time across its low-level
	// (raw signal features: bpm, key, loudness, etc.) and high-level (classifier outputs:
	// mood, danceability, genre, etc.) endpoints. Submissions to AB stopped in 2022, so
	// coverage falls off sharply for newer releases — but everything older is still there.
	async acousticbrainz(mbids, setStatus) {
		if (mbids.length === 0) return {}
		let q = enrich.makeQueue({ name: 'AcousticBrainz', minIntervalMs: 250 })
		let out = {}
		let chunks = []
		for (let i = 0; i < mbids.length; i += 25) chunks.push(mbids.slice(i, i + 25))
		let done = 0
		for (let chunk of chunks) {
			if (q.aborted) break
			setStatus?.('AcousticBrainz ' + done + '-' + (done + chunk.length) + '/' + mbids.length)
			let ids = chunk.join(';')
			let [low, high] = await Promise.all([
				q.call('https://acousticbrainz.org/api/v1/low-level?recording_ids=' + ids),
				q.call('https://acousticbrainz.org/api/v1/high-level?recording_ids=' + ids),
			])
			for (let mbid of chunk) {
				// AB returns shape {mbid: {"0": {...}}} where "0" is the first submission for that MBID
				let lo = low?.[mbid]?.['0']
				let hi = high?.[mbid]?.['0']
				if (!lo && !hi) continue
				let hl = hi?.highlevel || {}
				let pick = k => hl[k] ? hl[k].value + ' (' + (+hl[k].probability).toFixed(2) + ')' : '' // classifier verdict + confidence
				out[mbid] = {
					bpm: lo?.rhythm?.bpm,
					key: lo?.tonal ? lo.tonal.key_key + ' ' + lo.tonal.key_scale : '',
					avg_loudness: lo?.lowlevel?.average_loudness,
					dynamic_complexity: lo?.lowlevel?.dynamic_complexity,
					danceability: pick('danceability'),
					mood_happy: pick('mood_happy'),
					mood_sad: pick('mood_sad'),
					mood_aggressive: pick('mood_aggressive'),
					mood_relaxed: pick('mood_relaxed'),
					mood_party: pick('mood_party'),
					voice_instrumental: pick('voice_instrumental'),
					tonal_atonal: pick('tonal_atonal'),
					timbre: pick('timbre'),
					genre_dortmund: pick('genre_dortmund'),
					genre_rosamerica: pick('genre_rosamerica'),
					gender: pick('gender'),
				}
			}
			done += chunk.length
		}
		return out
	},

	// CSV-safe rendering. Numbers go raw; strings get quoted with embedded quotes doubled.
	csvField(v) {
		if (v === undefined || v === null || v === '') return ''
		if (typeof v === 'number') return v
		return '"' + String(v).replace(/"/g, '""') + '"'
	},
}

// The table of this user's playlists, to be displayed mid-page in the playlistsContainer
class PlaylistTable extends React.Component {
	// By default the constructor passes properties to super.
	constructor(props) { super(props) } //render() gets called at the end of constructor execution

	// A constructor can't be async, but we need to asynchronously load data when the object is made.
	// Solve this with a separate function that initializes object data. Call it from render().
	// https://stackoverflow.com/questions/43431550/how-can-i-invoke-asynchronous-code-within-a-constructor
	async init() {
		let user = await utils.apiCall("https://api.spotify.com/v1/me")
		let library = await utils.apiCall("https://api.spotify.com/v1/me/tracks?offset=0&limit=1")

		// fake a playlist-like structure for the liked songs, so it plays well with the rest of the code
		let liked_songs = {name: "Liked Songs", external_urls: {spotify: "https://open.spotify.com/collection/tracks"},
			images:[{url: "liked_songs.jpeg"}], owner: {id: user.id, external_urls: {spotify: user.external_urls.spotify}},
			tracks: {total: library.total, href: "https://api.spotify.com/v1/me/tracks"}}
		let playlists = [[liked_songs]] // double list so .flat() flattens everything right later

		// Compose a list of all the user's playlists by querying the playlists endpoint. Their total number of playlists
		// needs to be garnered from a response, so await the first response, then send a volley of requests to get the rest.
		// https://developer.spotify.com/documentation/web-api/reference/get-list-users-playlists
		let response = await utils.apiCall("https://api.spotify.com/v1/me/playlists?limit=50&offset=0")
		playlists.push(response.items)
		let requests = []
		for (let offset = 50; offset < response.total; offset += 50) {
			requests.push(utils.apiCall("https://api.spotify.com/v1/me/playlists?limit=50&offset=" + offset, 2*offset-100))
		}
		await Promise.all(requests).then(responses => responses.map(response => playlists.push(response.items)))

		//add info to this Component's state. Use setState() so render() gets called again.
		this.setState({ playlists: playlists.flat() }) // flatten list of lists into just a list
		subtitle.textContent = this.state.playlists.length + ' playlists\n' // directly reference an HTML element by id
	}

	// Make the table sortable
	sortRows(column) {
		// Change arrow icons appropriately
		let allSorts = Array.from(document.querySelectorAll('[id^="sortBy"]')) // querySelectorAll returns NodeList, not Array https://eloquentjavascript.net/14_dom.html#h-5ooQzToxht https://developer.mozilla.org/en-US/docs/Web/API/NodeList
		let arrow = allSorts.find(el => el.id == "sortBy"+column) // find the one just clicked
		allSorts.forEach(el => { if (el != arrow) {el.className = "fa fa-fw fa-sort"; el.style.color = '#C0C0C0'} }) // change the other two back to the greyed-out double-arrow
		if (arrow.className.endsWith("fa-sort") || arrow.className.endsWith("fa-sort-asc")) { arrow.className = "fa fa-fw fa-sort-desc" } //if the icon is fa-sort or asc, change to desc
		else if (arrow.className.endsWith("fa-sort-desc")) { arrow.className = "fa fa-fw fa-sort-asc" } //if descending, change to ascending
		arrow.style.color = "#000000" // darken
		
		// rearrange table rows
		function field(p) { // get the keyed column contents
			if (column == "Name") { return p.name } else if (column == "Owner") { return p.owner.id } }
		this.setState({ playlists: this.state.playlists.sort((a, b) => // make sure to use setState() so React reacts! Calling render() doesn't cut the mustard.	
			arrow.className.endsWith("desc") ? // figure out whether we're ascending or descending
				column == "Tracks" ? a.tracks.total - b.tracks.total : field(a).localeCompare(field(b)) : // for numeric column, just use the difference to get a + or - number
				column == "Tracks" ? b.tracks.total - a.tracks.total : field(b).localeCompare(field(a))) }) // for string columns, use something fancier to handle capitals and such
	}

	// createElement is a legacy API https://react.dev/reference/react/createElement, but I like it better than JSX at the moment
	// https://stackoverflow.com/questions/78433001/why-is-createelement-a-part-of-the-legacy-api
	render() {
		if (this.state?.playlists.length > 0) {
			return React.createElement("div", { id: "playlists" },
				React.createElement("table", { className: "table table-hover" },
					// table header
					React.createElement("thead", null, // have to explicitly pass null because the children come as *args _after_ the second argument
						React.createElement("tr", null,
							React.createElement("th", { style: { width: "30px" }}),
							React.createElement("th", null, "Name",
								React.createElement("i", { className: "fa fa-fw fa-sort", style: { color: '#C0C0C0' }, id: "sortByName", onClick: () => this.sortRows("Name")} )),
							React.createElement("th", null, "Owner",
								React.createElement("i", { className: "fa fa-fw fa-sort", style: { color: '#C0C0C0' }, id: "sortByOwner", onClick: () => this.sortRows("Owner")} )),
							React.createElement("th", {style: {minWidth: "100px"}}, "Tracks",
								React.createElement("i", { className: "fa fa-fw fa-sort", style: { color: '#C0C0C0' }, id: "sortByTracks", onClick: () => this.sortRows("Tracks")} )),
							React.createElement("th", { className: "text-right"},
								React.createElement("button", { className: "btn btn-default btn-xs", type: "submit", id: "exportAll",
									onClick: () => PlaylistExporter.exportAll(this.state.playlists) },
									React.createElement("i", { className: "fa fa-file-archive-o"}), " Export All")))),
					//table body
					React.createElement("tbody", null,
						this.state.playlists.map((playlist, i) =>
							React.createElement("tr", null, // tr = table row
								React.createElement("td", null, // td = table data
									React.createElement("img", { src: playlist.images?.length > 0 ? playlist.images[0].url : "https://placehold.co/30?text=blank", style: { width: "30px", height: "30px" }})),
								React.createElement("td", null, React.createElement("a", { href: playlist.external_urls.spotify }, playlist.name)),
								React.createElement("td", null, React.createElement("a", { href: playlist.owner.external_urls.spotify }, playlist.owner.id)),
								React.createElement("td", null, playlist.tracks.total),
								React.createElement("td", { className: "text-right" },
									React.createElement("button", { className: "btn btn-default btn-xs btn-success", id: "export" + i, onClick: () => PlaylistExporter.export(this.state.playlists[i], i) },
										React.createElement("i", { className: "fa fa-download" }) /* download icon */, " Export")))))))
		} else {
			this.init()
			return React.createElement("div", { className: "spinner"})
		}
	}
}

// Handles exporting playlists as CSV files
let PlaylistExporter = {
	// Take the access token string and playlist object, generate a csv from it, and when that data is resolved and
	// returned, save to a file.
	async export(playlist, row) {
		let btn = document.getElementById("export"+row)
		let setStatus = s => { btn.innerHTML = '<i class="fa fa-circle-o-notch fa-spin"></i> ' + s }
		setStatus('Exporting') // spinner on button
		try {
			let csv = await this.csvData(playlist, setStatus)
			saveAs(new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }), this.fileName(playlist) + ".csv")
		} catch (e) {
			error.innerHTML += "Couldn't export " + playlist.name + ". Encountered <tt>" + e + "</tt><br/>" + e.stack +
					'<br/>Please <a href="https://github.com/pavelkomarov/exportify/issues">let us know</a>.'
		} finally { // change back the export button's text
			btn.innerHTML = '<i class="fa fa-download"></i> Export'
		}
	},

	// Handles exporting all playlist data as a zip file
	async exportAll(playlists) {
		exportAll.innerHTML = '<i class="fa fa-circle-o-notch fa-spin"></i> Exporting' // spinner on button
		error.innerHTML = ""
		let zip = new JSZip()

		for (let playlist of playlists) {
			let setStatus = s => { exportAll.innerHTML = '<i class="fa fa-circle-o-notch fa-spin"></i> ' + playlist.name + ': ' + s }
			try {
				let csv = await this.csvData(playlist, setStatus)
				let fileName = this.fileName(playlist)
				while (zip.file(fileName + ".csv")) { fileName += "_" } // Add underscores if the file already exists so playlists with duplicate names don't overwrite each other.
				zip.file(fileName + ".csv", csv)
			} catch (e) { // Surface all errors
				error.innerHTML += "Couldn't export " + playlist.name + " with id " + playlist.id + ". Encountered <tt>" + e +
					"</tt><br>" + e.stack + '<br>Please <a href="https://github.com/pavelkomarov/exportify/issues">let us know</a>. ' +
					"The others are still being zipped.<br/>"
			}
		}
		exportAll.innerHTML= '<i class="fa fa-file-archive-o"></i> Export All' // change back button text
		saveAs(zip.generate({ type: "blob" }), "spotify_playlists.zip")
	},

	// take the playlist object and return an acceptable filename
	fileName(playlist) {
		return playlist.name.replace(/[\/\\:*?"<>|]/g, '').replace(/\s+/g, '_')// /.../g is a Perl-style modifier, g for global, meaning all matches replaced
	},

	// This is where the magic happens. The access token gives us permission to query this info from Spotify, and the
	// playlist object gives us all the information we need to start asking for songs.
	async csvData(playlist, setStatus = () => {}) {
		let increment = playlist.name == "Liked Songs" ? 50 : 100 // Can max call for only 50 tracks at a time vs 100 for playlists
		setStatus('Fetching tracks')

		// Make asynchronous API calls for 100 songs at a time, and put the results (all Promises) in a list.
		let requests = []
		for (let offset = 0; offset < playlist.tracks.total; offset += increment) {
			requests.push(utils.apiCall(playlist.tracks.href + '?offset=' + offset + '&limit=' + increment, (offset/increment)*100)) // I'm spacing requests by 100ms regardless of increment.
		}
		// "returns a single Promise that resolves when all of the promises passed as an iterable have resolved"
		// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/all
		let artist_ids = new Set()
		let album_ids = new Set()
		let track_isrcs = {} // uri -> ISRC, the cross-service key we'll use for Deezer / MusicBrainz / AcousticBrainz
		let data_promise = Promise.all(requests).then(responses => { // Gather all the data from the responses in a table.
			return responses.map(response => { // apply to all responses
				return response.items.map(song => { // apply to all songs in each response
					// Safety check! If there are artists/album listed and they have non-null identifier, add them to the sets
					song.track?.artists?.forEach(a => { if (a && a.id) { artist_ids.add(a.id) } })
					if (song.track?.album && song.track.album.id) { album_ids.add(song.track.album.id) }
					if (song.track?.uri && song.track.external_ids?.isrc) { track_isrcs[song.track.uri] = song.track.external_ids.isrc }
					// Commas in various fields can throw off csv, so surround with quotes. Quotes are escaped by doubling "".
					// For robustness to missing data, null-checking question marks abound. Artists are separated with
					// semicolons so commas can be preserved in their names without confusion.
					return ['"'+song.track?.artists?.map(artist => { return artist?.id }).join(',')+'"', song.track?.album?.id, song.track?.uri,
						'"'+song.track?.name?.replace(/"/g,'""')+'"', '"'+song.track?.album?.name?.replace(/"/g,'""')+'"',
						'"'+song.track?.artists?.map(artist => { return artist?.name?.replace(/"/g,'""').replace(/;/g,'') }).join(';')+'"',
						song.track?.album?.release_date, song.track?.duration_ms, song.track?.popularity, song.track?.explicit, song.added_by?.id, song.added_at]
				})
			})
		})

		// Make queries on all the artists, because this json is where genre information lives. Unfortunately this
		// means a second wave of traffic, 50 artists at a time the maximum allowed.
		let genre_promise = data_promise.then(() => {
			artist_ids = Array.from(artist_ids) // Make groups of 50 artists, to all be queried together
			let artist_chunks = []; while (artist_ids.length) { artist_chunks.push(artist_ids.splice(0, 50)) }
			let artists_promises = artist_chunks.map((chunk_ids, i) => utils.apiCall(
				'https://api.spotify.com/v1/artists?ids='+chunk_ids.join(','), 100*i)) // volley of traffic, requests staggered by 100ms
			return Promise.all(artists_promises).then(responses => {
				let artist_genres = {} // build a dictionary, rather than a table
				responses.forEach(response => response.artists.forEach(
					artist => { if (artist) {artist_genres[artist.id] = artist.genres.join(',')} } )) // these are the artists who had ids before, but it's still possible they aren't in the genre database
				return artist_genres
			})
		})

		// Fetch album details, another wave of traffic, 20 albums at a time max. Happens after genre_promise has finished, to build in delay.
		let album_promise = Promise.all([data_promise, genre_promise]).then(() => {
			album_ids = Array.from(album_ids) // chunk set of ids into 20s
			let album_chunks = []; while (album_ids.length) { album_chunks.push(album_ids.splice(0, 20)) }
			let album_promises = album_chunks.map((chunk_ids, i) => utils.apiCall(
				'https://api.spotify.com/v1/albums?ids=' + chunk_ids.join(','), 120*i))
			return Promise.all(album_promises).then(responses => {
				let record_labels = {} // analogous to genres
				responses.forEach(response => response.albums.forEach(
					album => { if (album) { record_labels[album.id] = album.label } } ))
				return record_labels
			})
		})

		// Pull external enrichment data keyed by ISRC. Runs sequentially across services so we
		// don't pile concurrent traffic on top of three different rate-limited backends. Each
		// service has its own circuit breaker — failures in one don't affect the others.
		let enrich_promise = Promise.all([data_promise, genre_promise, album_promise]).then(async () => {
			let unique_isrcs = [...new Set(Object.values(track_isrcs))]
			let deezer = await enrich.deezer(unique_isrcs, setStatus)
			let mb = await enrich.musicbrainz(unique_isrcs, setStatus)
			let unique_mbids = Object.values(mb).map(v => v.mbid).filter(Boolean)
			let ab = await enrich.acousticbrainz(unique_mbids, setStatus)
			return { deezer, mb, ab }
		}).catch(e => { // any unhandled throw in the chain shouldn't kill the whole export
			enrich.warn('Enrichment phase failed unexpectedly (' + e.message + '); CSV will export without enriched columns.')
			return { deezer: {}, mb: {}, ab: {} }
		})

		// join the tables, label the columns, and put all data in a single csv string
		return Promise.all([data_promise, genre_promise, album_promise, enrich_promise]).then(values => {
			let [data, artist_genres, record_labels, enriched] = values
			setStatus?.('Building CSV')
			data = data.flat() // get rid of the batch dimension (only 100 songs per call)
			data.forEach(row => {
				// add genres
				let artist_ids = row.shift()?.slice(1, -1).split(',') // strip the quotes from artist ids, and toss; user doesn't need to see ids
				let deduplicated_genres = new Set(artist_ids?.map(a => artist_genres[a]).join(",").split(",")) // in case multiple artists
				row.push('"'+Array.from(deduplicated_genres).filter(x => x != "").join(",")+'"') // remove empty strings
				// add album details
				let album_id = row.shift()
				row.push('"'+record_labels[album_id]+'"')
				// add enrichment columns (ISRC + Deezer + MusicBrainz + AcousticBrainz)
				let uri = row[0]
				let isrc = track_isrcs[uri]
				let d = isrc ? enriched.deezer[isrc] : null
				let m = isrc ? enriched.mb[isrc] : null
				let a = m?.mbid ? enriched.ab[m.mbid] : null
				row.push(enrich.csvField(isrc))
				row.push(enrich.csvField(d?.bpm), enrich.csvField(d?.gain))
				row.push(enrich.csvField(m?.mbid), enrich.csvField(m?.tags))
				row.push(enrich.csvField(a?.bpm), enrich.csvField(a?.key), enrich.csvField(a?.avg_loudness), enrich.csvField(a?.dynamic_complexity),
					enrich.csvField(a?.danceability), enrich.csvField(a?.mood_happy), enrich.csvField(a?.mood_sad),
					enrich.csvField(a?.mood_aggressive), enrich.csvField(a?.mood_relaxed), enrich.csvField(a?.mood_party),
					enrich.csvField(a?.voice_instrumental), enrich.csvField(a?.tonal_atonal), enrich.csvField(a?.timbre),
					enrich.csvField(a?.genre_dortmund), enrich.csvField(a?.genre_rosamerica), enrich.csvField(a?.gender))
			})
			// make a string
			let csv = "Track URI,Track Name,Album Name,Artist Name(s),Release Date,Duration (ms),Popularity,Explicit,Added By,Added At,Genres,Record Label,ISRC,Deezer BPM,Deezer Gain,MB Recording ID,MB Tags,AB BPM,AB Key,AB Average Loudness,AB Dynamic Complexity,AB Danceability,AB Mood Happy,AB Mood Sad,AB Mood Aggressive,AB Mood Relaxed,AB Mood Party,AB Voice/Instrumental,AB Tonal/Atonal,AB Timbre,AB Genre (Dortmund),AB Genre (Rosamerica),AB Gender\n"
			data.forEach(row => { csv += row.join(",") + "\n" })
			return csv
		})
	}
}

// runs when the page loads
onload = async () => {
	let code = new URLSearchParams(location.search).get('code') // try to snag a code out of the url, in case this is after authorize()
	if (code) {
		history.replaceState({}, '', '/') // get rid of the ugly code string from the browser bar

		let client_id = window.CONFIG?.spotify_client_id || "d99b082b01d74d61a100c9a0e056380b"
		let response = await fetch("https://accounts.spotify.com/api/token", { method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'},
			body: new URLSearchParams({client_id: client_id, grant_type: 'authorization_code', code: code, redirect_uri: location.origin,
				code_verifier: localStorage.getItem('code_verifier')}) }) // POST to get the access token, then fish it out of the response body
		localStorage.setItem('access_token', (await response.json()).access_token) // https://stackoverflow.com/questions/59555534/why-is-json-asynchronous
		localStorage.setItem('access_token_timestamp', Date.now())
	}
	if (localStorage.getItem('access_token') && Date.now() - localStorage.getItem('access_token_timestamp') < 3600000) {
		loginButton.style.display = 'none' // When logged in, make the login button invisible
		logoutContainer.innerHTML = '<button id="logoutButton" class="btn btn-sm" onclick="utils.logout()">Log Out</button>' // Add a logout button by modifying the HTML
		ReactDOM.render(React.createElement(PlaylistTable), playlistsContainer) // Create table and put it in the playlistsContainer	
	}
}
