const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export class WebRTCPeer {
  constructor(signaling, iceServers = DEFAULT_ICE_SERVERS) {
    this.signaling   = signaling;
    this._iceServers = iceServers;

    this.onTrack                 = null;
    this.onConnectionStateChange = null;

    this._pc               = new RTCPeerConnection({ iceServers });
    this._videoTransceiver = null;
    this._audioTransceiver = null;

    this._bindSignaling();
    this._bindPeerConnection();
  }

  // Tear down and recreate the RTCPeerConnection (e.g. after a peer reconnects).
  // Signaling handlers are NOT re-bound — they reference this._pc via `this`
  // and will automatically use the new instance.
  reset() {
    this._pc.close();
    this._pc               = new RTCPeerConnection({ iceServers: this._iceServers });
    this._videoTransceiver = null;
    this._audioTransceiver = null;
    this._bindPeerConnection();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  setupTransceivers() {
    this._videoTransceiver = this._pc.addTransceiver('video', { direction: 'sendrecv' });
    this._audioTransceiver = this._pc.addTransceiver('audio', { direction: 'sendrecv' });
  }

  async createOffer() {
    const offer = await this._pc.createOffer();
    await this._pc.setLocalDescription(offer);
    this.signaling.send({ type: 'offer', sdp: offer });
  }

  // Replace the outgoing video track (null = stop sending video)
  async replaceVideoTrack(track) {
    if (this._videoTransceiver) {
      await this._videoTransceiver.sender.replaceTrack(track);
    }
  }

  // Replace the outgoing audio track
  async replaceAudioTrack(track) {
    if (this._audioTransceiver) {
      await this._audioTransceiver.sender.replaceTrack(track);
    }
  }

  close() { this._pc.close(); }

  get peerConnection()  { return this._pc; }
  get connectionState() { return this._pc.connectionState; }

  // Used by adaptive.js — null when nobody is sharing
  get videoSender() { return this._videoTransceiver?.sender ?? null; }

  // ── Private ────────────────────────────────────────────────────────────────

  _bindSignaling() {
    this.signaling.onMessage(async (msg) => {
      switch (msg.type) {
        case 'offer': {
          await this._pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));

          // Ensure this side can also send (offer arrives as recvonly by default)
          for (const tc of this._pc.getTransceivers()) {
            if (tc.direction === 'recvonly') tc.direction = 'sendrecv';
          }

          // Transceivers are created in the order of m-lines in the offer SDP,
          // which matches the order setupTransceivers() added them on the offerer's side.
          const tcs = this._pc.getTransceivers();
          this._videoTransceiver = tcs[0] ?? null;
          this._audioTransceiver = tcs[1] ?? null;

          const answer = await this._pc.createAnswer();
          await this._pc.setLocalDescription(answer);
          this.signaling.send({ type: 'answer', sdp: answer });
          break;
        }
        case 'answer':
          await this._pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          break;

        case 'ice-candidate':
          if (msg.candidate) {
            await this._pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
          }
          break;
      }
    });
  }

  _bindPeerConnection() {
    this._remoteStream = new MediaStream();

    this._pc.addEventListener('icecandidate', ({ candidate }) => {
      if (candidate) this.signaling.send({ type: 'ice-candidate', candidate });
    });

    this._pc.addEventListener('track', ({ track }) => {
      this._remoteStream.addTrack(track);
      // Fire for every track so Firefox re-evaluates srcObject when audio arrives
      this.onTrack?.(this._remoteStream);
    });

    this._pc.addEventListener('connectionstatechange', () => {
      this.onConnectionStateChange?.(this._pc.connectionState);
    });
  }
}
