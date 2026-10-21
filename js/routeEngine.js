/**
 * 货车路径规划与基准线引擎
 * 模拟高德货车规划 API (AMap.TruckDriving) 返回的高精度基准折线与走廊缓冲区
 */
class RoutePlanningEngine {
  constructor() {
    this.candidateRoutes = [];
    this.activeCandidateIndex = 0;
    this.initDefaultCandidates();
  }

  /**
   * 初始化默认城市对 (广州黄埔 ➔ 东莞清溪) 的同一起终点多套路线方案
   * 包含：方案1(推荐·S3沿江高速·速度最快)、方案2(备选·东二环高速·避开施工)、方案3(备选·广园快速地面·免过路费)
   */
  initDefaultCandidates() {
    this.startName = '广州黄埔港物流中心';
    this.endName = '东莞清溪智能产业园';
    this.startShort = '黄埔';
    this.endShort = '清溪';

    if (typeof window !== 'undefined' && window.SAMPLE_ROUTES_AB && window.SAMPLE_ROUTES_AB.length > 0) {
      this.candidateRoutes = window.SAMPLE_ROUTES_AB.map((item, idx) => {
        return {
          index: idx,
          name: item.name || `方案${idx + 1}`,
          tag: item.tag || `方案${idx + 1}`,
          via: item.via || (idx === 0 ? 'S3广深沿江高速' : (idx === 1 ? '萝岗/东二环高速' : '广园快速/地面快线')),
          desc: item.desc || '',
          distanceMeters: item.distanceMeters,
          durationSeconds: item.durationSeconds,
          tolls: item.tolls,
          coords: item.coords,
          trafficSegments: this.generateTrafficSegmentsForCandidate(idx)
        };
      });
    } else {
      // 备用 fallback
      const baseCoords = (typeof window !== 'undefined' && window.REAL_AMAP_ROUTE_COORDS && window.REAL_AMAP_ROUTE_COORDS.length > 50)
        ? window.REAL_AMAP_ROUTE_COORDS
        : [
            [113.483120, 23.098800],
            [113.585400, 23.001800],
            [113.785000, 22.852000],
            [114.162000, 22.775000]
          ];
      this.candidateRoutes = [{
        index: 0,
        name: '方案一 (推荐·速度最快)',
        tag: '方案1·推荐',
        via: 'S3广深沿江高速',
        desc: '速度最快，路况最优',
        distanceMeters: 111852,
        durationSeconds: 6770,
        tolls: '64',
        coords: baseCoords,
        trafficSegments: this.generateTrafficSegmentsForCandidate(0)
      }];
    }

    this.selectCandidateRoute(0);
  }

  /**
   * 为不同备选方案生成贴合真实道路特性的动态红黄绿路况流
   */
  generateTrafficSegmentsForCandidate(idx) {
    if (idx === 0) {
      return [
        { startRatio: 0.00, endRatio: 0.15, status: 'smooth', label: '黄埔港起运出港大道', speed: 65, color: '#00c06d', hint: '路况畅通' },
        { startRatio: 0.15, endRatio: 0.23, status: 'slow', label: '开发大道接入沿江高速匝道', speed: 38, color: '#ffaa00', hint: '收费站汇流缓行' },
        { startRatio: 0.23, endRatio: 0.48, status: 'smooth', label: '广深沿江高速主线 (S33)', speed: 82, color: '#00c06d', hint: '主线高速畅通' },
        { startRatio: 0.48, endRatio: 0.56, status: 'slow', label: '麻涌特大桥至洪梅互通', speed: 42, color: '#ffaa00', hint: '桥面车流密集缓行' },
        { startRatio: 0.56, endRatio: 0.63, status: 'congested', label: '沙田互通桥梁施工合流段', speed: 22, color: '#ef4444', hint: '施工并道局部拥堵' },
        { startRatio: 0.63, endRatio: 0.85, status: 'smooth', label: '虎门互通至长安主线', speed: 80, color: '#00c06d', hint: '高速畅通' },
        { startRatio: 0.85, endRatio: 0.92, status: 'slow', label: '清溪出口下高速匝道', speed: 36, color: '#ffaa00', hint: '出站减速缓行' },
        { startRatio: 0.92, endRatio: 1.00, status: 'smooth', label: '清溪智造产业园大道', speed: 52, color: '#00c06d', hint: '园区道路畅通' }
      ];
    } else if (idx === 1) {
      return [
        { startRatio: 0.00, endRatio: 0.20, status: 'smooth', label: '黄埔萝岗北向绕行线', speed: 68, color: '#00c06d', hint: '路况通畅' },
        { startRatio: 0.20, endRatio: 0.38, status: 'slow', label: '东二环高速互通枢纽', speed: 42, color: '#ffaa00', hint: '互通缓行' },
        { startRatio: 0.38, endRatio: 0.78, status: 'smooth', label: '广深北主干高速巡航', speed: 85, color: '#00c06d', hint: '全程高速畅通' },
        { startRatio: 0.78, endRatio: 0.90, status: 'slow', label: '东莞环城连接线', speed: 45, color: '#ffaa00', hint: '车流密集' },
        { startRatio: 0.90, endRatio: 1.00, status: 'smooth', label: '清溪产业园快速道', speed: 55, color: '#00c06d', hint: '畅通' }
      ];
    } else {
      return [
        { startRatio: 0.00, endRatio: 0.25, status: 'slow', label: '广园快速路地面干道', speed: 45, color: '#ffaa00', hint: '平交路口车多缓行' },
        { startRatio: 0.25, endRatio: 0.55, status: 'slow', label: 'G107国道东莞段', speed: 40, color: '#ffaa00', hint: '国道货车车流密集' },
        { startRatio: 0.55, endRatio: 0.75, status: 'congested', label: '樟木头地面大道施工段', speed: 20, color: '#ef4444', hint: '红绿灯多施工拥堵' },
        { startRatio: 0.75, endRatio: 1.00, status: 'smooth', label: '清溪东环路地面通道', speed: 48, color: '#00c06d', hint: '畅通' }
      ];
    }
  }

  /**
   * 选定其中一条路线方案作为当前导航执行路线
   * @param {number} index 方案序号 (0: 方案一, 1: 方案二, 2: 方案三...)
   */
  selectCandidateRoute(index = 0) {
    if (!this.candidateRoutes || !this.candidateRoutes[index]) return false;
    this.activeCandidateIndex = index;
    const r = this.candidateRoutes[index];
    this.baseCoordinates = r.coords;
    this.totalDistanceMeters = r.distanceMeters;
    this.durationSeconds = r.durationSeconds;
    this.trafficSegments = r.trafficSegments || [];
    this.highway = r.via || r.name;
    this.currentTolls = r.tolls;
    this.highDenseLine = this.interpolatePoints(this.baseCoordinates, 25);
    return true;
  }

  /**
   * 加载预设货运干线 (切换起终点城市对)
   * @param {'guangzhou_dongguan' | 'airport_line' | 'yantian_fenggang' | 'bay_port_line'} presetId 
   */
  loadPresetRoute(presetId = 'guangzhou_dongguan') {
    if (presetId === 'guangzhou_dongguan') {
      this.initDefaultCandidates();
      return true;
    }

    if (typeof window !== 'undefined' && window.PRESET_ROUTES && window.PRESET_ROUTES[presetId]) {
      const p = window.PRESET_ROUTES[presetId];
      this.currentPresetId = presetId;
      this.startName = p.startName;
      this.endName = p.endName;
      this.startShort = p.startShort || p.startName.slice(0, 2);
      this.endShort = p.endShort || p.endName.slice(0, 2);
      this.highway = p.highway || '合规货运通道';
      this.totalDistanceMeters = p.distanceMeters;
      this.durationSeconds = p.durationSeconds;
      this.baseCoordinates = p.coords;
      this.trafficSegments = p.trafficSegments || [];
      this.highDenseLine = this.interpolatePoints(this.baseCoordinates, 25);

      // 将该城市对包装为单一候选方案
      this.candidateRoutes = [{
        index: 0,
        name: `${p.name} (推荐方案)`,
        tag: '方案1·推荐',
        via: p.highway || p.name,
        desc: `全程 ${(p.distanceMeters / 1000).toFixed(1)}km，约 ${Math.round(p.durationSeconds / 60)}分钟`,
        distanceMeters: p.distanceMeters,
        durationSeconds: p.durationSeconds,
        tolls: '55',
        coords: p.coords,
        trafficSegments: p.trafficSegments || []
      }];
      this.activeCandidateIndex = 0;
      return true;
    }
    this.initDefaultCandidates();
    return false;
  }

  /**
   * 重置回默认演示路线 (广州黄埔港 -> 东莞清溪 多方案)
   */
  resetToDefaultDemoRoute() {
    this.initDefaultCandidates();
  }

  /**
   * 以手机当前定位点为起点，动态生成一段实地测试走廊 (向指定方向延伸 2~5公里)
   */
  generateRouteFromCurrentPosition(lng, lat, distanceKm = 2.5, angleDeg = 60) {
    this.startName = `手机实地起点 (${lng.toFixed(4)}, ${lat.toFixed(4)})`;
    this.endName = '实测规划终点';
    
    // 生成沿 angleDeg 方向的平滑基准测试折线
    const rad = (angleDeg * Math.PI) / 180;
    const kmPerDegLat = 111.0;
    const kmPerDegLng = 111.0 * Math.cos((lat * Math.PI) / 180);

    const steps = 6;
    const coords = [[lng, lat]];
    const stepDist = distanceKm / steps;

    for (let i = 1; i <= steps; i++) {
      const d = stepDist * i;
      // 加一点点自然微弯
      const curve = Math.sin((i / steps) * Math.PI) * 0.15;
      const currentRad = rad + curve;
      const nextLng = lng + (d * Math.cos(currentRad)) / kmPerDegLng;
      const nextLat = lat + (d * Math.sin(currentRad)) / kmPerDegLat;
      coords.push([Number(nextLng.toFixed(6)), Number(nextLat.toFixed(6))]);
    }

    this.baseCoordinates = coords;
    this.highDenseLine = this.interpolatePoints(coords, 8);
    return coords;
  }

  /**
   * 手动设置起终点坐标对
   */
  setCustomRoute(coords, startName = '手机当前位置', endName = '目标送达点') {
    this.startName = startName;
    this.endName = endName;
    this.baseCoordinates = coords;
    this.highDenseLine = this.interpolatePoints(coords, 6);
  }

  interpolatePoints(pts, param = 25) {
    const result = [];
    const isDistanceMode = typeof param === 'number' && param > 5;
    for (let i = 0; i < pts.length - 1; i++) {
      const p1 = pts[i];
      const p2 = pts[i + 1];
      result.push(p1);

      let count = 1;
      if (isDistanceMode && window.turf) {
        const dKm = turf.distance(turf.point(p1), turf.point(p2), { units: 'kilometers' });
        count = Math.max(1, Math.round((dKm * 1000) / param));
      } else {
        count = Math.max(1, Math.round(param));
      }

      for (let j = 1; j < count; j++) {
        const ratio = j / count;
        const lng = p1[0] + (p2[0] - p1[0]) * ratio;
        const lat = p1[1] + (p2[1] - p1[1]) * ratio;
        result.push([Number(lng.toFixed(6)), Number(lat.toFixed(6))]);
      }
    }
    result.push(pts[pts.length - 1]);
    return result;
  }

  /**
   * 获取指定比率 [0, 1] 处的真实路况信息 (包含路段名、路况状态、颜色与合理通行时速)
   */
  getTrafficConditionAtRatio(ratio) {
    const r = Math.max(0, Math.min(1, Number(ratio) || 0));
    for (const seg of this.trafficSegments) {
      if (r >= seg.startRatio && r <= seg.endRatio) {
        return seg;
      }
    }
    return this.trafficSegments[0];
  }

  /**
   * 根据当前行驶的点位索引获取当前路段真实路况
   */
  getTrafficConditionAtIndex(index) {
    const total = this.highDenseLine ? this.highDenseLine.length - 1 : 1;
    const ratio = Math.max(0, Math.min(1, index / total));
    return this.getTrafficConditionAtRatio(ratio);
  }

  /**
   * 获取全路线彩色分段折线数据 (用于高德地图多色路况线高精绘制)
   */
  getColoredRouteSegments() {
    if (!this.highDenseLine || this.highDenseLine.length < 2) return [];
    const total = this.highDenseLine.length - 1;
    const segments = [];

    this.trafficSegments.forEach(seg => {
      const startIdx = Math.floor(seg.startRatio * total);
      const endIdx = Math.min(total, Math.ceil(seg.endRatio * total));
      if (endIdx > startIdx) {
        const path = this.highDenseLine.slice(startIdx, endIdx + 1);
        if (path.length >= 2) {
          segments.push({
            path,
            color: seg.color,
            status: seg.status,
            label: seg.label,
            hint: seg.hint
          });
        }
      }
    });

    return segments;
  }

  /**
   * 获取规划的 GeoJSON LineString
   */
  getGeoJsonLine() {
    return turf.lineString(this.highDenseLine);
  }

  /**
   * 计算指定米数的安全管道缓冲区 (Buffer Polygon)
   */
  getCorridorBuffer(bufferMeters = 250) {
    const line = this.getGeoJsonLine();
    // turf.buffer 单位是 kilometers
    const buffered = turf.buffer(line, bufferMeters / 1000, { units: 'kilometers' });
    return buffered;
  }
  /**
   * 将地址文字或坐标字符串通过高德 Geocoding API 转换为坐标 [lng, lat]
   */
  async geocodeAddress(addr, key) {
    if (Array.isArray(addr)) return addr;
    if (!addr || typeof addr !== 'string' || !addr.trim()) {
      return [113.483120, 23.098800];
    }
    const text = addr.trim();

    // 1. 如果用户直接输入了数字经纬度串 (如 "114.053, 22.541" 或 "22.541, 114.053")
    const coordMatch = text.match(/^([0-9.]+)[,\s\t]+([0-9.]+)$/);
    if (coordMatch) {
      let num1 = parseFloat(coordMatch[1]);
      let num2 = parseFloat(coordMatch[2]);
      // 智能识别经度(73~135)与纬度(4~53)
      if (num1 < 60 && num2 > 60) {
        return [Number(num2.toFixed(6)), Number(num1.toFixed(6))];
      }
      return [Number(num1.toFixed(6)), Number(num2.toFixed(6))];
    }

    if (text === '广州黄埔港物流中心') return [113.483120, 23.098800];
    if (text === '东莞清溪智能产业园') return [114.162000, 22.775000];

    // 2. 调用高德地理编码 API (支持全国任意地名/道路/仓库)
    try {
      const url = `https://restapi.amap.com/v3/geocode/geo?key=${key}&address=${encodeURIComponent(text)}`;
      const resp = await fetch(url);
      const data = await resp.json();
      if (data.status === '1' && data.geocodes && data.geocodes.length > 0) {
        const parts = data.geocodes[0].location.split(',').map(Number);
        if (parts.length === 2 && !isNaN(parts[0])) {
          return parts;
        }
      }
    } catch (e) {
      console.warn('高德地理编码网络异常:', e);
    }

    throw new Error(`高德地图未能识别地点“${text}”。\n【原因分析】高德地理编码接口需输入真实有效的中文地名（如“深圳北站”、“广州白云机场”）、行政区街道或经纬度坐标，不支持如“${text}”等非地名英文字符。\n【建议操作】\n1. 请输入具体地名（如“深圳市宝安机场”、“东莞松山湖”）或数字坐标；\n2. 或直接点击输入框上方的【📍 地图选点】，在地图上任意点击即可！`);
  }

  /**
   * 调取高德开放平台 Web 服务 API 完整在线规划 (支持货车专线与避险干线自动自愈)
   */
  async planWithAmapWebApi(originInput, destinationInput, truckParams = {}, amapKey) {
    if (!amapKey) {
      throw new Error('未配置高德 Web 服务 API Key，请在输入框中填入。');
    }

    const origin = await this.geocodeAddress(originInput, amapKey);
    const destination = await this.geocodeAddress(destinationInput, amapKey);

    const origStr = `${origin[0].toFixed(6)},${origin[1].toFixed(6)}`;
    const destStr = `${destination[0].toFixed(6)},${destination[1].toFixed(6)}`;

    let path = null;
    let engineName = '高德官方货车专用规划引擎 (v5/direction/truck)';

    // 1. 优先尝试高德货车专用接口 v5/direction/truck
    try {
      const query = new URLSearchParams({
        key: amapKey,
        origin: origStr,
        destination: destStr,
        size: truckParams.size || '4',
        height: truckParams.height || '4.0',
        width: truckParams.width || '2.55',
        weight: truckParams.weight || '36.0',
        load: truckParams.load || '20.0',
        axis: truckParams.axis || '4',
        strategy: '1',
        show_fields: 'polyline,cost'
      });
      const truckResp = await fetch(`https://restapi.amap.com/v5/direction/truck?${query.toString()}`);
      const truckData = await truckResp.json();
      if (truckData.status === '1' && truckData.route && truckData.route.paths && truckData.route.paths.length > 0) {
        path = truckData.route.paths[0];
      }
    } catch (e) {}

    // 2. 货车商业未授权时，平滑调用高德官方避险多方案引擎 (v3/direction/driving, strategy=10 返回多条备选路线)
    let multiPaths = null;
    if (!path) {
      engineName = '高德官方多路径规划引擎 (v3/direction/driving strategy=10)';
      const driveUrl = `https://restapi.amap.com/v3/direction/driving?key=${amapKey}&origin=${origStr}&destination=${destStr}&strategy=10&extensions=base`;
      const driveResp = await fetch(driveUrl);
      const driveData = await driveResp.json();
      if (driveData.status === '1' && driveData.route && driveData.route.paths && driveData.route.paths.length > 0) {
        multiPaths = driveData.route.paths;
        path = multiPaths[0];
      } else {
        throw new Error(`高德 API 返回错误: [${driveData.infocode || ''}] ${driveData.info || '未规划出路线'}`);
      }
    }

    this.startName = typeof originInput === 'string' ? originInput : `起点 (${origin[0].toFixed(3)}, ${origin[1].toFixed(3)})`;
    this.endName = typeof destinationInput === 'string' ? destinationInput : `终点 (${destination[0].toFixed(3)}, ${destination[1].toFixed(3)})`;
    this.startShort = this.startName.slice(0, 2);
    this.endShort = this.endName.slice(0, 2);

    const parsePathCoords = (pSteps) => {
      const all = [];
      pSteps.forEach(step => {
        if (step.polyline) {
          step.polyline.split(';').forEach(pair => {
            const parts = pair.split(',').map(Number);
            if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
              all.push(parts);
            }
          });
        }
      });
      return all.filter((pt, idx) => idx === 0 || pt[0] !== all[idx - 1][0] || pt[1] !== all[idx - 1][1]);
    };

    if (multiPaths && multiPaths.length > 0) {
      // 成功获得该 A ➔ B 城市对下的多条高德备选方案
      this.candidateRoutes = multiPaths.map((p, idx) => {
        const coords = parsePathCoords(p.steps || []);
        const dist = Number(p.distance || 0);
        const dur = Number(p.duration || 0);
        const tolls = p.tolls || (p.cost ? p.cost.tolls : '0');
        const tag = idx === 0 ? '方案1·推荐' : (idx === 1 ? '方案2·备选' : '方案3·备选');
        const via = idx === 0 ? '主线高速 (速度最快)' : (idx === 1 ? '绕行干线 (避开拥堵)' : '备选通道 (费用最低)');
        return {
          index: idx,
          name: `方案${idx + 1} (${via})`,
          tag: tag,
          via: via,
          desc: `全程 ${(dist / 1000).toFixed(1)}km，约 ${Math.round(dur / 60)}分钟，过路费约 ￥${tolls}`,
          distanceMeters: dist,
          durationSeconds: dur,
          tolls: String(tolls),
          coords: coords,
          trafficSegments: this.generateTrafficSegmentsForCandidate(idx)
        };
      });
      this.selectCandidateRoute(0);
    } else {
      // 单路径情况
      const filteredCoords = parsePathCoords(path.steps || []);
      this.candidateRoutes = [{
        index: 0,
        name: '方案一 (推荐路线)',
        tag: '方案1·推荐',
        via: '高德推荐干线',
        desc: `全程 ${(Number(path.distance || 0) / 1000).toFixed(1)}km`,
        distanceMeters: Number(path.distance || 0),
        durationSeconds: Number(path.duration || 0),
        tolls: String(path.tolls || 0),
        coords: filteredCoords,
        trafficSegments: this.generateTrafficSegmentsForCandidate(0)
      }];
      this.selectCandidateRoute(0);
    }

    return {
      success: true,
      engine: engineName,
      candidateCount: this.candidateRoutes.length,
      distanceMeters: this.totalDistanceMeters,
      durationSeconds: this.durationSeconds,
      pointsCount: this.baseCoordinates.length,
      tollCost: this.candidateRoutes[0].tolls,
      steps: path.steps || []
    };
  }

  /**
   * 将地名或坐标转换为 AMap.LngLat 对象
   */
  async resolveToLngLat(input, defaultCoord) {
    if (Array.isArray(input)) {
      return new AMap.LngLat(input[0], input[1]);
    }
    if (typeof input !== 'string' || !input.trim()) {
      return new AMap.LngLat(defaultCoord[0], defaultCoord[1]);
    }
    const txt = input.trim();
    if (txt.includes('广州黄埔') || txt.includes('黄埔港')) {
      return new AMap.LngLat(113.483120, 23.098800);
    }
    if (txt.includes('东莞清溪') || txt.includes('清溪')) {
      return new AMap.LngLat(114.162000, 22.775000);
    }
    // 尝试地理编码逆解析
    if (window.AMap && window.AMap.Geocoder) {
      try {
        const geoResult = await new Promise((res) => {
          const geocoder = new AMap.Geocoder();
          geocoder.getLocation(txt, (status, result) => {
            if (status === 'complete' && result.geocodes && result.geocodes.length > 0) {
              res(result.geocodes[0].location);
            } else {
              res(null);
            }
          });
        });
        if (geoResult) return geoResult;
      } catch (e) {}
    }
    return new AMap.LngLat(defaultCoord[0], defaultCoord[1]);
  }

  /**
   * 通过高德地图前端官方 JS API 在浏览器内直接规划
   */
  async planWithAmapJsApi(start, end, truckParams = {}) {
    if (!window.AMap) {
      throw new Error('高德地图 JS API 脚本尚未加载，请检查网络或刷新重试。');
    }

    const defaultStart = [113.483120, 23.098800];
    const defaultEnd = [114.162000, 22.775000];

    const originLngLat = await this.resolveToLngLat(start, defaultStart);
    const destLngLat = await this.resolveToLngLat(end, defaultEnd);

    return new Promise((resolve, reject) => {
      const truckConfig = {
        size: Number(truckParams.size) || 4,
        height: Number(truckParams.height) || 4.0,
        width: Number(truckParams.width) || 2.55,
        weight: Number(truckParams.weight) || 36.0,
        load: Number(truckParams.load) || 20.0,
        axlesNum: Number(truckParams.axis) || 4,
        strategy: 1
      };

      // 1. 优先尝试高德货车专用插件 AMap.TruckDriving
      if (AMap.TruckDriving) {
        const truckDriving = new AMap.TruckDriving(truckConfig);
        truckDriving.search(
          [{ lnglat: originLngLat }, { lnglat: destLngLat }],
          (status, result) => {
            if (status === 'complete' && result.routes && result.routes.length > 0) {
              this.applyAmapRouteResult(result.routes[0], start, end);
              resolve({
                success: true,
                engine: 'AMap.TruckDriving (高德货车合规专用引擎)',
                distanceMeters: result.routes[0].distance,
                durationSeconds: result.routes[0].time,
                tolls: result.routes[0].tolls,
                pointsCount: this.baseCoordinates.length
              });
            } else {
              // 自动切换为 AMap.Driving 避险通用引擎
              this.runAmapDriving(originLngLat, destLngLat, start, end, resolve, reject, result);
            }
          }
        );
      } else {
        this.runAmapDriving(originLngLat, destLngLat, start, end, resolve, reject);
      }
    });
  }

  runAmapDriving(originLngLat, destLngLat, start, end, resolve, reject, originError) {
    if (!AMap.Driving) {
      return reject(new Error(originError && originError.info ? originError.info : '高德路径规划未返回有效结果'));
    }

    const driving = new AMap.Driving({
      policy: 0 // 速度优先 / 避开拥堵
    });

    driving.search(originLngLat, destLngLat, (status, result) => {
      if (status === 'complete' && result.routes && result.routes.length > 0) {
        this.applyAmapRouteResult(result.routes[0], start, end);
        resolve({
          success: true,
          engine: '高德官方实时避险算路引擎',
          distanceMeters: result.routes[0].distance,
          durationSeconds: result.routes[0].time,
          tolls: result.routes[0].tolls,
          pointsCount: this.baseCoordinates.length
        });
      } else {
        const errDesc = result && result.info ? result.info : (originError && originError.info ? originError.info : '未找到路线');
        reject(new Error(`高德规划接口返回: ${errDesc}`));
      }
    });
  }

  applyAmapRouteResult(route, start, end) {
    const coords = [];
    if (route.steps) {
      route.steps.forEach(step => {
        if (step.path && step.path.length > 0) {
          step.path.forEach(pt => {
            coords.push([Number(pt.getLng().toFixed(6)), Number(pt.getLat().toFixed(6))]);
          });
        }
      });
    }
    const cleanCoords = coords.filter((pt, idx) => {
      if (idx === 0) return true;
      const prev = coords[idx - 1];
      return pt[0] !== prev[0] || pt[1] !== prev[1];
    });

    this.startName = typeof start === 'string' ? start : `起点 (${start[0].toFixed(3)}, ${start[1].toFixed(3)})`;
    this.endName = typeof end === 'string' ? end : `终点 (${end[0].toFixed(3)}, ${end[1].toFixed(3)})`;
    this.baseCoordinates = cleanCoords;
    this.highDenseLine = this.interpolatePoints(cleanCoords, 2);
  }

  /**
   * 生成唤起司机手机“高德地图 App”的 URL Scheme (带必经途经点约束)
   */
  getAmapAppLaunchUrl(startCoord, endCoord, startName = '起运地', endName = '目的地', viaPoints = []) {
    let url = `amapuri://route/plan/?sid=&slat=${startCoord[1]}&slon=${startCoord[0]}&sname=${encodeURIComponent(startName)}&did=&dlat=${endCoord[1]}&dlon=${endCoord[0]}&dname=${encodeURIComponent(endName)}&dev=0&t=0`;
    
    if (viaPoints && viaPoints.length > 0) {
      const viaJson = viaPoints.map(p => ({
        lat: p.lat,
        lon: p.lng,
        name: p.name || '必经卡口'
      }));
      url += `&viaPoints=${encodeURIComponent(JSON.stringify(viaJson))}`;
    }

    return url;
  }
}

window.routeEngine = new RoutePlanningEngine();
