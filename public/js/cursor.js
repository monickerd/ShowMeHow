export class Cursor {
  constructor(el) {
    this._el        = el;
    this._hideTimer = null;
  }

  // x, y are normalized 0..1 coordinates relative to the client's full viewport
  update(x, y) {
    this.updatePx(x * window.innerWidth, y * window.innerHeight);
  }

  // Position cursor at explicit viewport pixel coordinates
  updatePx(px, py) {
    this._el.style.left    = `${px}px`;
    this._el.style.top     = `${py}px`;
    this._el.style.display = 'block';

    clearTimeout(this._hideTimer);
    this._hideTimer = setTimeout(() => this.hide(), 3000);
  }

  hide() {
    this._el.style.display = 'none';
    clearTimeout(this._hideTimer);
  }
}
