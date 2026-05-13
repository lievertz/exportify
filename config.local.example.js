// Copy this file to config.local.js (which is gitignored) and fill in your own values.
// config.local.js is loaded before exportify.js, so anything set on window.CONFIG overrides
// the defaults baked into exportify.js. If config.local.js doesn't exist, the page works
// fine with the production defaults.
window.CONFIG = {
	// Your Spotify Developer Dashboard app's client ID. The redirect URIs whitelisted in
	// that app must include whatever origin you serve this page from (e.g. http://[::1]:8765).
	spotify_client_id: "your-client-id-here",
}
