// How phones talk to each other.
//   'p2p'    – no server needed (GitHub Pages): the host's browser runs the
//              game and friends connect to it directly over WebRTC.
//   'server' – the Node server runs the game (it serves its own config.js
//              with this mode, so you never need to edit this for that).
//
// peer: PeerJS signalling options. Leave empty to use the free PeerJS cloud,
// or point at your own `peerjs` server, e.g. { host: 'peer.example.com', path: '/' }.
export default { mode: 'p2p', peer: {} };
