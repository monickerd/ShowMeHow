const POLL_INTERVAL_MS = 3000;
const RTT_WARN_MS      = 250;
const LOSS_WARN_PCT    = 0.05;

export class Adaptive {
  constructor(peer) {
    this._peer  = peer;
    this._timer = null;
  }

  start() {
    if (this._timer !== null) return;
    this._timer = setInterval(() => this._poll(), POLL_INTERVAL_MS);
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
  }

  async _poll() {
    const pc = this._peer.peerConnection;
    if (!pc || pc.connectionState !== 'connected') return;

    const stats   = await pc.getStats();
    const quality = this._evaluate(stats);
    if (quality === 'poor') this._reduceQuality();
  }

  _evaluate(stats) {
    let worstRtt  = 0;
    let lossRatio = 0;
    stats.forEach(report => {
      if (report.type === 'remote-inbound-rtp' && report.kind === 'video') {
        if (report.roundTripTime)      worstRtt  = Math.max(worstRtt, report.roundTripTime);
        if (report.fractionLost != null) lossRatio = Math.max(lossRatio, report.fractionLost);
      }
    });
    return (worstRtt > RTT_WARN_MS / 1000 || lossRatio > LOSS_WARN_PCT) ? 'poor' : 'good';
  }

  async _reduceQuality() {
    const sender = this._peer.videoSender;
    if (!sender || !sender.track) return;

    const params = sender.getParameters();
    if (!params.encodings?.length) return;

    for (const enc of params.encodings) {
      if (enc.maxFramerate == null || enc.maxFramerate > 10) {
        enc.maxFramerate = Math.max(10, Math.floor((enc.maxFramerate ?? 30) / 2));
      } else if (!enc.maxBitrate || enc.maxBitrate > 300_000) {
        enc.maxBitrate = Math.max(300_000, Math.floor((enc.maxBitrate ?? 2_000_000) / 2));
      }
    }

    await sender.setParameters(params).catch(() => {});
  }
}
