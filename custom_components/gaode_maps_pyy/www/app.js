(function () {
  "use strict";

  const query = new URLSearchParams(window.location.search);
  const ROUTE_PLUGIN_NAMES = ["AMap.Driving", "AMap.Walking", "AMap.Riding"];
  const BASE_PLUGINS = ["AMap.Scale", "AMap.ToolBar", "AMap.MapType"];

  class GaodeMapApp {
    constructor() {
      this.mode = query.get("mode") || "panel";
      this.key = query.get("gaodekey") || "";
      this.jsCode = query.get("jscode") || "";
      this.serviceHost = query.get("servicehost") || "";
      this.deviceFilter = this.parseDeviceList(query.get("devicetrackeridlist") || query.get("idlist") || "");
      this.zoom = Number(query.get("zoom") || 15);
      this.token = this.resolveToken(query.get("hasstoken") || "");
      this.apiBase = window.location.origin;

      this.AMap = null;
      this.map = null;
      this.homePoint = null;
      this.selectedDeviceId = null;
      this.routeMode = "drive";
      this.routeSearch = null;
      this.routeReady = null;
      this.trafficLayer = null;
      this.trafficVisible = false;
      this.zonesVisible = true;
      this.darkMode = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;

      this.devices = new Map();
      this.deviceMarkers = new Map();
      this.zoneOverlays = [];
      this.refreshTimer = null;

      this.trackPolyline = null;
      this.trackMarker = null;
      this.trackPoints = [];
      this.trackIndex = 0;
      this.trackTimer = null;
      this.trackPlaying = false;

      this.elements = {};
    }

    async init() {
      this.cacheElements();
      this.applyMode();
      this.bindEvents();
      this.initDateInputs();

      if (!this.key) {
        this.toast("缺少高德 Web Key，请检查集成配置。");
        this.setSummary("缺少高德 Web Key");
        return;
      }
      if (!this.token) {
        this.toast("缺少 Home Assistant token，请配置长期访问令牌。");
        this.setSummary("缺少 Home Assistant token");
        return;
      }

      try {
        await this.loadHomeConfig();
        await this.loadAmap();
        await this.loadStates();
        this.refreshTimer = window.setInterval(() => this.loadStates(true), 10000);
        this.setSummary("地图已就绪");
      } catch (error) {
        console.error(error);
        this.toast("地图初始化失败，请查看浏览器控制台。");
        this.setSummary("初始化失败");
      }
    }

    cacheElements() {
      const ids = [
        "sidePanel", "summaryText", "reloadButton", "fitButton", "trafficButton", "zonesButton",
        "themeButton", "deviceList", "deviceCount", "routeStatus", "trackStatus", "trackFrom",
        "trackTo", "trackLoadButton", "trackPlayButton", "trackPauseButton", "trackStopButton",
        "cardOverlay", "cardTitle", "cardSubtitle", "toast"
      ];
      ids.forEach((id) => {
        this.elements[id] = document.getElementById(id);
      });
    }

    applyMode() {
      if (this.mode === "card") {
        this.elements.sidePanel.classList.add("hidden");
        this.elements.cardOverlay.classList.remove("hidden");
      }
    }

    bindEvents() {
      this.elements.reloadButton.addEventListener("click", () => this.loadStates());
      this.elements.fitButton.addEventListener("click", () => this.fitAll());
      this.elements.trafficButton.addEventListener("click", () => this.toggleTraffic());
      this.elements.zonesButton.addEventListener("click", () => this.toggleZones());
      this.elements.themeButton.addEventListener("click", () => this.toggleTheme());
      this.elements.trackLoadButton.addEventListener("click", () => this.loadTrack());
      this.elements.trackPlayButton.addEventListener("click", () => this.playTrack());
      this.elements.trackPauseButton.addEventListener("click", () => this.pauseTrack());
      this.elements.trackStopButton.addEventListener("click", () => this.stopTrack());
      document.querySelectorAll("[data-route-mode]").forEach((button) => {
        button.addEventListener("click", () => {
          this.routeMode = button.dataset.routeMode;
          document.querySelectorAll("[data-route-mode]").forEach((item) => item.classList.toggle("active", item === button));
          this.planRoute();
        });
      });
      window.addEventListener("beforeunload", () => this.destroy());
    }

    initDateInputs() {
      const now = new Date();
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      this.elements.trackFrom.value = this.toLocalDatetimeValue(start);
      this.elements.trackTo.value = this.toLocalDatetimeValue(now);
    }

    async loadAmap() {
      if (this.jsCode) {
        window._AMapSecurityConfig = { securityJsCode: this.jsCode };
      } else if (this.serviceHost) {
        window._AMapSecurityConfig = { serviceHost: this.serviceHost };
      }

      this.AMap = await AMapLoader.load({
        key: this.key,
        version: "2.0",
        plugins: BASE_PLUGINS
      });
      this.AMap.getConfig().appname = "amap-jsapi-skill";

      const center = this.homePoint ? this.toGaodePoint(this.homePoint) : [104.195397, 35.86166];
      this.map = new this.AMap.Map("map", {
        viewMode: "3D",
        zoom: this.mode === "card" ? this.zoom : 12,
        center: center,
        pitch: this.mode === "card" ? 0 : 28,
        mapStyle: this.darkMode ? "amap://styles/dark" : "amap://styles/normal"
      });
      this.map.addControl(new this.AMap.Scale());
      this.map.addControl(new this.AMap.ToolBar({ position: "RT" }));
      this.map.addControl(new this.AMap.MapType());
      this.trafficLayer = new this.AMap.TileLayer.Traffic({ zIndex: 12 });
    }

    async loadHomeConfig() {
      const data = await this.fetchJson("/api/config");
      if (this.hasCoordinate(data)) {
        this.homePoint = {
          latitude: Number(data.latitude),
          longitude: Number(data.longitude)
        };
      }
    }

    async loadStates(silent) {
      const states = await this.fetchJson("/api/states");
      const zones = [];
      const incoming = new Map();

      states.forEach((state) => {
        if (state.entity_id && state.entity_id.startsWith("zone.") && this.hasCoordinate(state.attributes)) {
          zones.push(state);
          return;
        }
        if (!state.entity_id || !state.entity_id.startsWith("device_tracker.")) {
          return;
        }
        if (this.deviceFilter.length && !this.deviceFilter.includes(state.entity_id)) {
          return;
        }
        incoming.set(state.entity_id, this.normalizeDevice(state));
      });

      this.devices = incoming;
      this.renderDevices();
      this.renderZones(zones);
      this.updateDeviceList();
      this.updateCardInfo();
      if (!silent) {
        this.fitAll();
      }
    }

    renderDevices() {
      this.deviceMarkers.forEach((marker, entityId) => {
        if (!this.devices.has(entityId)) {
          marker.setMap(null);
          this.deviceMarkers.delete(entityId);
        }
      });

      this.devices.forEach((device, entityId) => {
        if (!this.hasCoordinate(device)) {
          return;
        }
        const position = this.toGaodePoint(device);
        let marker = this.deviceMarkers.get(entityId);
        if (marker) {
          marker.setPosition(position);
          marker.setContent(this.markerHtml(device.name, "device"));
          marker.setExtData(device);
        } else {
          marker = new this.AMap.Marker({
            map: this.map,
            position: position,
            content: this.markerHtml(device.name, "device"),
            offset: new this.AMap.Pixel(-18, -18),
            extData: device
          });
          marker.on("click", () => {
            this.selectDevice(entityId);
            this.openMoreInfo(entityId);
          });
          this.deviceMarkers.set(entityId, marker);
        }
      });
    }

    renderZones(zones) {
      this.zoneOverlays.forEach((overlay) => overlay.setMap(null));
      this.zoneOverlays = [];

      zones.forEach((zone) => {
        const position = this.toGaodePoint({
          latitude: Number(zone.attributes.latitude),
          longitude: Number(zone.attributes.longitude)
        });
        const marker = new this.AMap.Marker({
          map: this.zonesVisible ? this.map : null,
          position: position,
          content: this.markerHtml(zone.attributes.friendly_name || zone.entity_id, "zone"),
          offset: new this.AMap.Pixel(-18, -18)
        });
        const circle = new this.AMap.Circle({
          map: this.zonesVisible ? this.map : null,
          center: position,
          radius: Number(zone.attributes.radius || 100),
          fillColor: "#22c55e",
          fillOpacity: 0.16,
          strokeColor: "#16a34a",
          strokeOpacity: 0.7,
          strokeWeight: 1
        });
        this.zoneOverlays.push(marker, circle);
      });
    }

    updateDeviceList() {
      const items = Array.from(this.devices.values());
      this.elements.deviceCount.textContent = `${items.length} 个`;
      this.elements.deviceList.innerHTML = items.map((device) => {
        const active = device.entity_id === this.selectedDeviceId ? " active" : "";
        const locationText = this.hasCoordinate(device)
          ? `${Number(device.longitude).toFixed(5)}, ${Number(device.latitude).toFixed(5)}`
          : "无位置";
        return `
          <button class="device-row${active}" data-device-id="${this.escapeHtml(device.entity_id)}">
            <div class="device-title">
              <span>${this.escapeHtml(device.name)}</span>
              <span class="text-[11px] text-slate-400">${this.escapeHtml(device.state || "")}</span>
            </div>
            <div class="device-meta">${this.escapeHtml(device.address || locationText)}</div>
          </button>
        `;
      }).join("");
      this.elements.deviceList.querySelectorAll("[data-device-id]").forEach((button) => {
        button.addEventListener("click", () => this.selectDevice(button.dataset.deviceId));
      });
    }

    selectDevice(entityId) {
      this.selectedDeviceId = entityId;
      this.updateDeviceList();
      const device = this.devices.get(entityId);
      const marker = this.deviceMarkers.get(entityId);
      if (device && marker) {
        this.map.setCenter(marker.getPosition());
        this.map.setZoom(Math.max(this.map.getZoom(), this.zoom));
        this.setSummary(`已选择 ${device.name}`);
        this.elements.routeStatus.textContent = "可规划当前位置到 HA 家位置的路线";
        this.elements.trackStatus.textContent = "可查询该设备历史轨迹";
        this.updateCardInfo();
      }
    }

    async planRoute() {
      if (!this.selectedDeviceId) {
        this.toast("请先选择设备。");
        return;
      }
      if (!this.homePoint) {
        this.toast("Home Assistant 未配置家位置。");
        return;
      }
      const device = this.devices.get(this.selectedDeviceId);
      if (!device || !this.hasCoordinate(device)) {
        this.toast("当前设备没有经纬度。");
        return;
      }

      try {
        await this.loadRoutePlugins();
        if (this.routeSearch && this.routeSearch.clear) {
          this.routeSearch.clear();
        }
        const ClassRef = this.getRouteClass();
        this.routeSearch = new ClassRef({
          map: this.map,
          hideMarkers: true,
          autoFitView: false,
          showTraffic: this.routeMode === "drive"
        });
        const start = this.toGaodePoint(device);
        const end = this.toGaodePoint(this.homePoint);
        this.elements.routeStatus.textContent = "正在规划路线...";
        this.routeSearch.search(start, end, (status, result) => {
          if (status !== "complete") {
            console.warn("Route failed", result);
            this.elements.routeStatus.textContent = "路线规划失败";
            return;
          }
          const route = result.routes && result.routes[0];
          this.elements.routeStatus.textContent = route
            ? `${this.formatDistance(route.distance)} / ${this.formatDuration(route.time)}`
            : "路线规划完成";
        });
      } catch (error) {
        console.warn("Route plugin failed", error);
        this.elements.routeStatus.textContent = "路线插件加载失败";
      }
    }

    loadRoutePlugins() {
      if (!this.routeReady) {
        this.routeReady = new Promise((resolve) => {
          this.AMap.plugin(ROUTE_PLUGIN_NAMES, resolve);
        });
      }
      return this.routeReady;
    }

    getRouteClass() {
      if (this.routeMode === "walk") {
        return this.AMap.Walking;
      }
      if (this.routeMode === "ride") {
        return this.AMap.Riding;
      }
      return this.AMap.Driving;
    }

    async loadTrack() {
      if (!this.selectedDeviceId) {
        this.toast("请先选择设备。");
        return;
      }
      const from = this.elements.trackFrom.value;
      const to = this.elements.trackTo.value;
      if (!from || !to) {
        this.toast("请选择轨迹时间范围。");
        return;
      }
      this.stopTrack();
      const start = new Date(from).toISOString();
      const end = new Date(to).toISOString();
      const url = `/api/history/period/${encodeURIComponent(start)}?end_time=${encodeURIComponent(end)}&filter_entity_id=${encodeURIComponent(this.selectedDeviceId)}`;
      const data = await this.fetchJson(url);
      const rows = Array.isArray(data) && Array.isArray(data[0]) ? data[0] : [];
      this.trackPoints = rows
        .filter((row) => row.attributes && this.hasCoordinate(row.attributes))
        .map((row) => this.toGaodePoint({
          latitude: Number(row.attributes.latitude),
          longitude: Number(row.attributes.longitude)
        }));

      if (!this.trackPoints.length) {
        this.elements.trackStatus.textContent = "该时间段无轨迹";
        return;
      }
      this.clearTrack();
      this.trackPolyline = new this.AMap.Polyline({
        map: this.map,
        path: this.trackPoints,
        strokeColor: "#f97316",
        strokeWeight: 5,
        strokeOpacity: 0.95,
        lineJoin: "round",
        lineCap: "round",
        zIndex: 60
      });
      this.trackMarker = new this.AMap.Marker({
        map: this.map,
        position: this.trackPoints[0],
        content: '<div class="map-device-marker"><span class="marker-dot"></span><span class="marker-label">轨迹</span></div>',
        offset: new this.AMap.Pixel(-18, -18),
        zIndex: 80
      });
      this.trackIndex = 0;
      this.map.setFitView([this.trackPolyline]);
      this.elements.trackStatus.textContent = `已加载 ${this.trackPoints.length} 个轨迹点`;
    }

    playTrack() {
      if (!this.trackPoints.length || !this.trackMarker) {
        this.toast("请先查询轨迹。");
        return;
      }
      if (this.trackPlaying) {
        return;
      }
      this.trackPlaying = true;
      this.trackTimer = window.setInterval(() => {
        this.trackIndex += 1;
        if (this.trackIndex >= this.trackPoints.length) {
          this.stopTrack(false);
          return;
        }
        this.trackMarker.setPosition(this.trackPoints[this.trackIndex]);
        this.elements.trackStatus.textContent = `播放中 ${this.trackIndex + 1}/${this.trackPoints.length}`;
      }, 650);
    }

    pauseTrack() {
      this.trackPlaying = false;
      if (this.trackTimer) {
        window.clearInterval(this.trackTimer);
        this.trackTimer = null;
      }
      if (this.trackPoints.length) {
        this.elements.trackStatus.textContent = `已暂停 ${this.trackIndex + 1}/${this.trackPoints.length}`;
      }
    }

    stopTrack(resetPosition = true) {
      this.pauseTrack();
      if (resetPosition) {
        this.trackIndex = 0;
        if (this.trackMarker && this.trackPoints.length) {
          this.trackMarker.setPosition(this.trackPoints[0]);
        }
      }
      if (this.trackPoints.length) {
        this.elements.trackStatus.textContent = "轨迹已停止";
      }
    }

    clearTrack() {
      if (this.trackPolyline) {
        this.trackPolyline.setMap(null);
        this.trackPolyline = null;
      }
      if (this.trackMarker) {
        this.trackMarker.setMap(null);
        this.trackMarker = null;
      }
    }

    toggleTraffic() {
      this.trafficVisible = !this.trafficVisible;
      this.trafficLayer.setMap(this.trafficVisible ? this.map : null);
      this.elements.trafficButton.classList.toggle("active", this.trafficVisible);
    }

    toggleZones() {
      this.zonesVisible = !this.zonesVisible;
      this.zoneOverlays.forEach((overlay) => overlay.setMap(this.zonesVisible ? this.map : null));
      this.elements.zonesButton.classList.toggle("active", this.zonesVisible);
    }

    toggleTheme() {
      this.darkMode = !this.darkMode;
      this.map.setMapStyle(this.darkMode ? "amap://styles/dark" : "amap://styles/normal");
      this.elements.themeButton.classList.toggle("active", this.darkMode);
    }

    fitAll() {
      if (!this.map) {
        return;
      }
      const overlays = Array.from(this.deviceMarkers.values());
      this.zoneOverlays.forEach((overlay) => overlays.push(overlay));
      if (overlays.length) {
        this.map.setFitView(overlays, false, [60, 60, 60, 420]);
      } else if (this.homePoint) {
        this.map.setCenter(this.toGaodePoint(this.homePoint));
      }
    }

    updateCardInfo() {
      if (this.mode !== "card") {
        return;
      }
      const entityId = this.deviceFilter[0] || this.selectedDeviceId;
      const device = this.devices.get(entityId);
      if (device) {
        this.selectedDeviceId = entityId;
        this.elements.cardTitle.textContent = device.name;
        this.elements.cardSubtitle.textContent = device.address || device.state || "已定位";
        const marker = this.deviceMarkers.get(entityId);
        if (marker) {
          this.map.setCenter(marker.getPosition());
          this.map.setZoom(this.zoom);
        }
      } else {
        this.elements.cardSubtitle.textContent = "未找到设备位置";
      }
    }

    normalizeDevice(state) {
      return {
        entity_id: state.entity_id,
        name: state.attributes.friendly_name || state.entity_id,
        latitude: state.attributes.latitude == null ? null : Number(state.attributes.latitude),
        longitude: state.attributes.longitude == null ? null : Number(state.attributes.longitude),
        state: state.state,
        address: state.attributes.address || state.attributes.location_name || ""
      };
    }

    hasCoordinate(value) {
      return value && value.latitude != null && value.longitude != null && value.latitude !== "" && value.longitude !== "";
    }

    toGaodePoint(value) {
      const converted = coordinateutil.gcj_encrypt(Number(value.latitude), Number(value.longitude));
      return [converted.lon, converted.lat];
    }

    async fetchJson(path) {
      const headers = {};
      if (this.token) {
        headers.Authorization = this.token;
        headers["x-ha-access"] = this.token.replace(/^Bearer\s+/i, "");
      }
      const response = await fetch(`${this.apiBase}${path}`, { headers });
      if (!response.ok) {
        throw new Error(`HA API ${response.status}: ${path}`);
      }
      return response.json();
    }

    resolveToken(value) {
      const token = value || this.readStoredToken();
      if (!token) {
        return "";
      }
      return /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
    }

    readStoredToken() {
      try {
        const hassTokens = JSON.parse(window.localStorage.getItem("hassTokens") || "null");
        if (hassTokens && hassTokens.access_token) {
          return `${hassTokens.token_type || "Bearer"} ${hassTokens.access_token}`;
        }
        const tokens = JSON.parse(window.localStorage.getItem("tokens") || "null");
        if (tokens && tokens.access_token) {
          return `${tokens.token_type || "Bearer"} ${tokens.access_token}`;
        }
        return window.localStorage.getItem("authToken") || "";
      } catch (error) {
        return "";
      }
    }

    parseDeviceList(value) {
      return value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => item.startsWith("device_tracker.") ? item : `device_tracker.${item}`);
    }

    openMoreInfo(entityId) {
      try {
        const event = new Event("hass-more-info", {
          bubbles: true,
          cancelable: false,
          composed: true
        });
        event.detail = { entityId };
        parent.document.querySelector("home-assistant").dispatchEvent(event);
      } catch (error) {
        console.warn("Unable to open more-info", error);
      }
    }

    markerHtml(label, type) {
      const className = type === "zone" ? "map-zone-marker" : "map-device-marker";
      return `<div class="${className}"><span class="marker-dot"></span><span class="marker-label">${this.escapeHtml(label)}</span></div>`;
    }

    escapeHtml(value) {
      return String(value == null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    setSummary(text) {
      this.elements.summaryText.textContent = text;
    }

    toast(text) {
      this.elements.toast.textContent = text;
      this.elements.toast.classList.remove("hidden");
      window.clearTimeout(this.toastTimer);
      this.toastTimer = window.setTimeout(() => this.elements.toast.classList.add("hidden"), 3000);
    }

    toLocalDatetimeValue(date) {
      const pad = (value) => String(value).padStart(2, "0");
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    formatDistance(value) {
      const distance = Number(value || 0);
      return distance >= 1000 ? `${(distance / 1000).toFixed(1)} 公里` : `${Math.round(distance)} 米`;
    }

    formatDuration(value) {
      const seconds = Number(value || 0);
      if (seconds >= 3600) {
        return `${Math.floor(seconds / 3600)} 小时 ${Math.round((seconds % 3600) / 60)} 分钟`;
      }
      return `${Math.max(1, Math.round(seconds / 60))} 分钟`;
    }

    destroy() {
      if (this.refreshTimer) {
        window.clearInterval(this.refreshTimer);
      }
      this.pauseTrack();
      if (this.map) {
        this.map.destroy();
        this.map = null;
      }
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const app = new GaodeMapApp();
    window.gaodeMapApp = app;
    app.init();
  });
})();
