export class FeishuChannelConnectivity {
  #connected;

  constructor({ connected = false } = {}) {
    this.#connected = Boolean(connected);
  }

  get connected() {
    return this.#connected;
  }

  markConnected() {
    const recovered = !this.#connected;
    this.#connected = true;
    return recovered;
  }

  markDisconnected() {
    const changed = this.#connected;
    this.#connected = false;
    return changed;
  }

  observeInbound() {
    return this.markConnected();
  }

  observeTransportState(state) {
    if (state !== "connected") return false;
    return this.markConnected();
  }
}
