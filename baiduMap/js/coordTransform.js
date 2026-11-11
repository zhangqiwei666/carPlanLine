/**
 * 坐标系转换工具类 (Coordinate Transform Utility)
 * 解决国内主流地图测绘加密与国际标准坐标互转：
 * - WGS-84: 国际标准 GPS 芯片与北斗卫星原始物理坐标
 * - GCJ-02: 国家测绘局火星坐标系 (高德地图、腾讯地图)
 * - BD-09:  百度地图自研坐标系 (百度 WebGL 底图及 SDK 标准)
 */
(function(window) {
  const PI = Math.PI;
  const X_PI = (PI * 3000.0) / 180.0;
  const A = 6378245.0;
  const EE = 0.00669342162296594323;

  function outOfChina(lng, lat) {
    return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
  }

  function transformLat(x, y) {
    let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
    ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
    ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0;
    return ret;
  }

  function transformLng(x, y) {
    let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
    ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
    ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0;
    return ret;
  }

  const CoordTransform = {
    // 1. GCJ-02 (火星) ➔ BD-09 (百度)
    gcj02_to_bd09: function(lng, lat) {
      const z = Math.sqrt(lng * lng + lat * lat) + 0.00002 * Math.sin(lat * X_PI);
      const theta = Math.atan2(lat, lng) + 0.000003 * Math.cos(lng * X_PI);
      const bd_lng = z * Math.cos(theta) + 0.0065;
      const bd_lat = z * Math.sin(theta) + 0.006;
      return [Number(bd_lng.toFixed(6)), Number(bd_lat.toFixed(6))];
    },

    // 2. BD-09 (百度) ➔ GCJ-02 (火星)
    bd09_to_gcj02: function(bd_lng, bd_lat) {
      const x = bd_lng - 0.0065;
      const y = bd_lat - 0.006;
      const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * X_PI);
      const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * X_PI);
      const gg_lng = z * Math.cos(theta);
      const gg_lat = z * Math.sin(theta);
      return [Number(gg_lng.toFixed(6)), Number(gg_lat.toFixed(6))];
    },

    // 3. WGS-84 (GPS物理硬件) ➔ GCJ-02 (火星)
    wgs84_to_gcj02: function(lng, lat) {
      if (outOfChina(lng, lat)) return [lng, lat];
      let dLat = transformLat(lng - 105.0, lat - 35.0);
      let dLng = transformLng(lng - 105.0, lat - 35.0);
      const radLat = (lat / 180.0) * PI;
      let magic = Math.sin(radLat);
      magic = 1 - EE * magic * magic;
      const sqrtMagic = Math.sqrt(magic);
      dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
      dLng = (dLng * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI);
      return [Number((lng + dLng).toFixed(6)), Number((lat + dLat).toFixed(6))];
    },

    // 4. WGS-84 (GPS物理硬件) ➔ BD-09 (百度)
    wgs84_to_bd09: function(lng, lat) {
      const gcj = this.wgs84_to_gcj02(lng, lat);
      return this.gcj02_to_bd09(gcj[0], gcj[1]);
    },

    // 批量点序列转换
    batchGcj02ToBd09: function(coords) {
      if (!Array.isArray(coords)) return [];
      return coords.map(pt => this.gcj02_to_bd09(pt[0], pt[1]));
    },

    batchBd09ToGcj02: function(coords) {
      if (!Array.isArray(coords)) return [];
      return coords.map(pt => this.bd09_to_gcj02(pt[0], pt[1]));
    }
  };

  window.CoordTransform = CoordTransform;
})(window);
