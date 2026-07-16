customElements.whenDefined("ha-panel-lovelace").then(() => {
  const LitElement = Object.getPrototypeOf(customElements.get("ha-panel-lovelace"));
  const html = LitElement.prototype.html;
  const css = LitElement.prototype.css;

  customElements.define("gaode-map-pyy", class extends LitElement {
    static properties = {
      hass: {},
      stateObj: {},
      config: {}
    };

    static styles = css`
      iframe {
        border: none;
        display: block;
        width: 100%;
      }
    `;

    constructor() {
      super();
      this.credentials = this.readCredentials();
      this.loading = false;
    }

    static getStubConfig() {
      return {
        entity_id: "device_tracker.xxx",
        zoom: 16
      };
    }

    setConfig(config) {
      if (!config.entity_id) {
        throw new Error("你需要定义一个实体");
      }
      this.config = config;
    }

    render() {
      if (!this.credentials && !this.loading && this.hass) {
        this.loading = true;
        this.hass.callWS({ type: "gaode_maps_pyy", data: { type: "gaodekey" } }).then((data) => {
          this.credentials = data || {};
          sessionStorage.GAODE_PYY_CREDENTIALS = JSON.stringify(this.credentials);
          this.requestUpdate();
        });
      }

      if (!this.credentials) {
        return html`高德地图卡片加载中...`;
      }

      const entityId = this.stateObj ? this.stateObj.entity_id : this.config.entity_id;
      const zoom = this.stateObj ? 15 : (this.config.zoom || 15);
      const height = this.stateObj ? 300 : (this.offsetWidth || this.parentElement?.offsetWidth || 320);
      const params = new URLSearchParams({
        mode: "card",
        hasstoken: this.credentials.hasstoken || "",
        gaodekey: this.credentials.gaodekey || "",
        jscode: this.credentials.jscode || "",
        idlist: entityId,
        zoom: String(zoom),
        v: new Date().toISOString().slice(0, 10)
      });

      return html`
        <iframe style="height: ${height}px;" src="/gaode_maps_pyy_www/app.html?${params.toString()}"></iframe>
        ${this.stateObj ? html`<ha-attributes .hass=${this.hass} .stateObj=${this.stateObj}></ha-attributes>` : ""}
      `;
    }

    readCredentials() {
      try {
        return JSON.parse(sessionStorage.GAODE_PYY_CREDENTIALS || "null");
      } catch (error) {
        return null;
      }
    }
  });

  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "gaode-map-pyy",
    name: "高德地图自用版",
    preview: true,
    description: "高德地图自用版卡片"
  });
});
