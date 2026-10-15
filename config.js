// How phones talk to each other.
//   'relay'  – no server of our own (GitHub Pages): the host's browser runs the
//              game and phones swap messages through free public MQTT brokers.
//   'server' – the Node server runs the game (it serves its own config.js
//              with this mode, so you never need to edit this for that).
//
// brokers: MQTT-over-WebSocket URLs to use instead of the built-in public list.
export default { mode: 'relay', brokers: [] };
