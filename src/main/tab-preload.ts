// Preload for web-page tabs (sandboxed, no bridge exposed to the page).
// While an agent task drives this tab, WebRTC constructors are removed from the page's main world
// before any page script runs. The network-level control is setWebRTCIPHandlingPolicy
// ('disable_non_proxied_udp') in main; this is the second layer.
import { ipcRenderer, webFrame } from 'electron';

let active = false;
try {
  active = ipcRenderer.sendSync('tab:agent-active') === true;
} catch {
  active = false;
}
if (active) {
  void webFrame.executeJavaScript(`(() => {
    for (const k of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCIceTransport', 'RTCSctpTransport']) {
      try { Object.defineProperty(window, k, { value: undefined, writable: false, configurable: false }); } catch (e) {}
    }
  })()`);
}
