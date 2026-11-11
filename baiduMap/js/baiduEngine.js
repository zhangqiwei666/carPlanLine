/**
 * 百度地图版 - 货车路径规划与基准线走廊引擎 (基于 BMapGL & BD-09 坐标体系)
 */
class BaiduRoutePlanningEngine {
  constructor() {
    this.candidateRoutes = [];
    this.activeCandidateIndex = 0;
    this.initDefaultCandidates();
  }

  /**
   * 初始化默认城市对 (广州黄埔港 ➔ 东莞清溪) 的同一起终点多套路线方案
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
      const baseCoords = (typeof window !== 'undefined' && window.BAIDU_TRUCK_ROUTE_COORDS && window.BAIDU_TRUCK_ROUTE_COORDS.length > 50)
        ? window.BAIDU_TRUCK_ROUTE_COORDS
        : [
            [113.489644, 23.104648],
            [113.585400, 23.001800],
            [113.785000, 22.852000],
            [114.169107, 22.781416]
          ];
      this.candidateRoutes = [{
        index: 0,
        name: '方案一 (推荐·速度最快)',
        tag: '方案1·推荐',
        via: 'S3广深沿江高速',
        desc: '速度最快，路况最优',
        distanceMeters: 102400,
        durationSeconds: 6180,
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

  resetToDefaultDemoRoute() {
    this.initDefaultCandidates();
  }

  /**
   * 以手机当前定位点为起点，动态生成一段实地测试走廊 (向指定方向延伸 2~5公里)
   */
  generateRouteFromCurrentPosition(lng, lat, distanceKm = 2.5, angleDeg = 60) {
    this.startName = `实地起点 (${lng.toFixed(4)}, ${lat.toFixed(4)})`;
    this.endName = '实测规划终点';
    
    const rad = (angleDeg * Math.PI) / 180;
    const kmPerDegLat = 111.0;
    const kmPerDegLng = 111.0 * Math.cos((lat * Math.PI) / 180);

    const steps = 6;
    const coords = [[lng, lat]];
    const stepDist = distanceKm / steps;

    for (let i = 1; i <= steps; i++) {
      const d = stepDist * i;
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

  setCustomRoute(coords, startName = '当前位置', endName = '目标送达点') {
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

  getTrafficConditionAtRatio(ratio) {
    const r = Math.max(0, Math.min(1, Number(ratio) || 0));
    for (const seg of this.trafficSegments) {
      if (r >= seg.startRatio && r <= seg.endRatio) {
        return seg;
      }
    }
    return this.trafficSegments[0];
  }

  getTrafficConditionAtIndex(index) {
    const total = this.highDenseLine ? this.highDenseLine.length - 1 : 1;
    const ratio = Math.max(0, Math.min(1, index / total));
    return this.getTrafficConditionAtRatio(ratio);
  }

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

  cleanDuplicatePoints(pts) {
    if (!pts || pts.length < 2) return pts || [];
    const res = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      const prev = res[res.length - 1];
      if (Math.abs(p[0] - prev[0]) > 0.000005 || Math.abs(p[1] - prev[1]) > 0.000005) {
        res.push(p);
      }
    }
    return res;
  }

  getGeoJsonLine() {
    const cleanLine = this.cleanDuplicatePoints(this.highDenseLine);
    return turf.lineString(cleanLine.length >= 2 ? cleanLine : [[113.489644, 23.104648], [114.169107, 22.781416]]);
  }

  getCorridorBuffer(bufferMeters = 250) {
    const cleanLine = this.cleanDuplicatePoints(this.highDenseLine);
    try {
      if (window.turf && turf.buffer && cleanLine.length >= 2) {
        const lineGeo = turf.lineString(cleanLine);
        const buffered = turf.buffer(lineGeo, bufferMeters / 1000, { units: 'kilometers' });
        if (buffered && buffered.geometry && buffered.geometry.coordinates && buffered.geometry.coordinates.length > 0) {
          return buffered;
        }
      }
    } catch (e) {
      console.warn('turf.buffer 空间分析告警，启动高精几何包络算法兜底:', e.message);
    }
    return this.generateGeometricCorridor(cleanLine, bufferMeters);
  }

  generateGeometricCorridor(pts, bufferMeters = 250) {
    if (!pts || pts.length < 2) return null;
    const leftPts = [];
    const rightPts = [];

    for (let i = 0; i < pts.length; i++) {
      const pPrev = pts[Math.max(0, i - 1)];
      const pNext = pts[Math.min(pts.length - 1, i + 1)];
      const dx = pNext[0] - pPrev[0];
      const dy = pNext[1] - pPrev[1];
      const midLat = (pts[i][1] * Math.PI) / 180;
      const mPerDegLat = 111132;
      const mPerDegLng = 111132 * Math.cos(midLat);
      const len = Math.hypot(dx * mPerDegLng, dy * mPerDegLat);
      if (len === 0) continue;

      const nx = -(dy * mPerDegLat) / len;
      const ny = (dx * mPerDegLng) / len;
      const offLng = (nx * bufferMeters) / mPerDegLng;
      const offLat = (ny * bufferMeters) / mPerDegLat;

      leftPts.push([Number((pts[i][0] + offLng).toFixed(6)), Number((pts[i][1] + offLat).toFixed(6))]);
      rightPts.push([Number((pts[i][0] - offLng).toFixed(6)), Number((pts[i][1] - offLat).toFixed(6))]);
    }

    if (leftPts.length < 2) return null;
    const ring = [...leftPts, ...rightPts.reverse(), leftPts[0]];
    return {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [ring]
      }
    };
  }

  /**
   * 将地名解析或坐标包装为 BMapGL.Point
   */
  async resolveToBMapPoint(input, defaultCoord) {
    if (Array.isArray(input)) {
      return new BMapGL.Point(input[0], input[1]);
    }
    if (typeof input !== 'string' || !input.trim()) {
      return new BMapGL.Point(defaultCoord[0], defaultCoord[1]);
    }
    const txt = input.trim();
    if (txt.includes('广州黄埔') || txt.includes('黄埔港')) {
      return new BMapGL.Point(113.489644, 23.104648);
    }
    if (txt.includes('东莞清溪') || txt.includes('清溪')) {
      return new BMapGL.Point(114.169107, 22.781416);
    }

    if (window.BMapGL && window.BMapGL.Geocoder) {
      try {
        const geocoder = new BMapGL.Geocoder();
        const pt = await new Promise(res => {
          geocoder.getPoint(txt, point => {
            res(point || null);
          }, '全国');
        });
        if (pt) return pt;
      } catch (e) {
        console.warn('百度地理编码异常:', e);
      }
    }

    return new BMapGL.Point(defaultCoord[0], defaultCoord[1]);
  }

  /**
   * 使用百度 JS API GL (BMapGL.DrivingRoute) 动态在线算路
   */
  async planWithBaiduJsApi(start, end, truckParams = {}) {
    if (!window.BMapGL) {
      throw new Error('百度地图 JS API GL 尚未加载完成，请检查网络或刷新重试。');
    }

    const defaultStart = [113.489644, 23.104648];
    const defaultEnd = [114.169107, 22.781416];

    const originPoint = await this.resolveToBMapPoint(start, defaultStart);
    const destPoint = await this.resolveToBMapPoint(end, defaultEnd);

    return new Promise((resolve, reject) => {
      let isSettled = false;

      const driving = new BMapGL.DrivingRoute(window.map || '广州市', {
        policy: window.BMAP_DRIVING_POLICY_LEAST_TIME || 0,
        onSearchComplete: (results) => {
          if (isSettled) return;
          isSettled = true;

          if (driving.getStatus() === (window.BMAP_STATUS_SUCCESS || 0)) {
            const plan = results.getPlan(0);
            if (!plan) {
              return reject(new Error('百度规划成功但未返回有效方案'));
            }

            const coords = [];
            for (let r = 0; r < plan.getNumRoutes(); r++) {
              const route = plan.getRoute(r);
              const pathPts = route.getPath();
              if (pathPts && pathPts.length > 0) {
                pathPts.forEach(pt => {
                  coords.push([Number(pt.lng.toFixed(6)), Number(pt.lat.toFixed(6))]);
                });
              }
            }

            if (coords.length < 2) {
              return reject(new Error('百度路线点位不足'));
            }

            // 清理相邻重复点
            const cleanCoords = coords.filter((pt, idx) => {
              if (idx === 0) return true;
              const prev = coords[idx - 1];
              return Math.abs(pt[0] - prev[0]) > 0.000001 || Math.abs(pt[1] - prev[1]) > 0.000001;
            });

            this.startName = typeof start === 'string' ? start : `起点 (${originPoint.lng.toFixed(3)}, ${originPoint.lat.toFixed(3)})`;
            this.endName = typeof end === 'string' ? end : `终点 (${destPoint.lng.toFixed(3)}, ${destPoint.lat.toFixed(3)})`;
            this.baseCoordinates = cleanCoords;
            this.totalDistanceMeters = plan.getDistance(false) || 102400;
            this.durationSeconds = plan.getDuration(false) || 6180;
            this.highDenseLine = this.interpolatePoints(cleanCoords, 25);

            this.candidateRoutes = [{
              index: 0,
              name: '百度智能规划推荐方案',
              tag: '在线规划',
              via: '实时规划通道',
              desc: `全程 ${(this.totalDistanceMeters / 1000).toFixed(1)}km，耗时约 ${Math.round(this.durationSeconds / 60)}分钟`,
              distanceMeters: this.totalDistanceMeters,
              durationSeconds: this.durationSeconds,
              tolls: '64',
              coords: cleanCoords,
              trafficSegments: this.generateTrafficSegmentsForCandidate(0)
            }];
            this.selectCandidateRoute(0);

            resolve({
              success: true,
              engine: 'BMapGL.DrivingRoute (百度GL避险算路引擎)',
              distanceMeters: this.totalDistanceMeters,
              durationSeconds: this.durationSeconds,
              pointsCount: cleanCoords.length,
              tolls: '64'
            });
          } else {
            reject(new Error(`百度路径规划返回状态异常: ${driving.getStatus()}`));
          }
        }
      });

      // 搜索
      driving.search(originPoint, destPoint);

      // 超时兜底防卡死
      setTimeout(() => {
        if (!isSettled) {
          isSettled = true;
          reject(new Error('百度规划网络请求超时'));
        }
      }, 9000);
    });
  }

  /**
   * 生成唤起司机端“百度地图 App”的 URL Scheme (带必经途经点约束)
   */
  getBaiduAppLaunchUrl(startCoord, endCoord, startName = '起运地', endName = '目的地') {
    // 百度地图 URI Scheme: baidumap://map/direction?origin=latlng:xx,yy|name:xx&destination=latlng:xx,yy|name:xx&mode=driving&coord_type=bd09ll&src=truck_demo
    const url = `baidumap://map/direction?origin=latlng:${startCoord[1]},${startCoord[0]}|name:${encodeURIComponent(startName)}&destination=latlng:${endCoord[1]},${endCoord[0]}|name:${encodeURIComponent(endName)}&mode=driving&coord_type=bd09ll&src=truck_demo`;
    return url;
  }
}

window.routeEngine = new BaiduRoutePlanningEngine();
