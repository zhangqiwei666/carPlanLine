/**
 * 智能货运监控平台主调度程序 (百度地图 SDK 专版 - BMapGL WebGL 3D 引擎)
 */
function initBaiduApp() {
  if (window._baiduAppInitialized) return;
  window._baiduAppInitialized = true;
  // 1. 初始化百度开放平台官方原生 WebGL 3D 地图 (BMapGL，高精 BD-09 坐标体系)
  const map = new BMapGL.Map('map', {
    displayOptions: {
      building: true
    }
  });
  const defaultCenter = new BMapGL.Point(113.8000, 22.9500);
  map.centerAndZoom(defaultCenter, 11);
  map.enableScrollWheelZoom(true);
  window.map = map;

  // 1.1 自定义 HTML 覆盖物扩展类 (用于车标、起点、终点图标自由旋转与样式呈现)
  function CustomHTMLOverlay(point, html, offset = { x: 0, y: 0 }, zIndex = 300) {
    this._point = point;
    this._html = html;
    this._offset = offset;
    this._zIndex = zIndex;
  }
  CustomHTMLOverlay.prototype = new BMapGL.Overlay();
  CustomHTMLOverlay.prototype.initialize = function(m) {
    this._map = m;
    const div = document.createElement('div');
    div.style.position = 'absolute';
    div.style.zIndex = String(this._zIndex || 300);
    div.innerHTML = this._html;
    m.getPanes().markerPane.appendChild(div);
    this._div = div;
    return div;
  };
  CustomHTMLOverlay.prototype.draw = function() {
    if (!this._div || !this._point || !this._map) return;
    const pixel = this._map.pointToOverlayPixel(this._point);
    this._div.style.left = (pixel.x + this._offset.x) + 'px';
    this._div.style.top = (pixel.y + this._offset.y) + 'px';
  };
  CustomHTMLOverlay.prototype.setPosition = function(point) {
    this._point = point;
    this.draw();
  };
  CustomHTMLOverlay.prototype.setContent = function(html) {
    this._html = html;
    if (this._div) {
      this._div.innerHTML = html;
    }
  };

  // 2. 地图图层与状态变量定义
  let plannedPolylineLayer = null;
  let trafficPolylineLayers = [];
  let corridorPolygonLayer = null;
  let actualTrackLayer = null;
  let truckOverlay = null;
  let startOverlay = null;
  let endOverlay = null;

  const actualTrackPoints = [];

  // 手机真机 GPS 状态变量
  let isRealGpsMode = false;
  let isDriverNavActive = false;
  let realGpsWatchId = null;
  let realGpsUpdateCount = 0;
  let lastRealCoord = null;
  let lastRealFixTime = 0;
  let autoFollow = true;
  let is3DModeActive = true;
  let lastTrafficStatus = 'smooth';

  // 沿车辆当前航向角向前偏置的中心点坐标 (经典车载导航下沉视角核心)
  function getForwardOffsetCoord(lngLat, offsetMeters = 180, headingDeg = 0) {
    if (!lngLat) return [113.489644, 23.104648];
    if (window.turf && turf.destination) {
      try {
        const dest = turf.destination(turf.point(lngLat), offsetMeters / 1000, headingDeg, { units: 'kilometers' });
        return dest.geometry.coordinates;
      } catch (e) {}
    }
    const rad = (headingDeg * Math.PI) / 180;
    const latRad = (lngLat[1] * Math.PI) / 180;
    const dLat = (offsetMeters * Math.cos(rad)) / 111320;
    const dLng = (offsetMeters * Math.sin(rad)) / (111320 * Math.cos(latRad));
    return [lngLat[0] + dLng, lngLat[1] + dLat];
  }

  // 3. 绘制货车规划基准路线与安全走廊 (高精折线 + 百度路况色彩带)
  function drawBaseRouteAndCorridor() {
    if (plannedPolylineLayer) map.removeOverlay(plannedPolylineLayer);
    if (corridorPolygonLayer) map.removeOverlay(corridorPolygonLayer);
    if (startOverlay) map.removeOverlay(startOverlay);
    if (endOverlay) map.removeOverlay(endOverlay);

    if (trafficPolylineLayers.length) {
      trafficPolylineLayers.forEach(l => map.removeOverlay(l));
      trafficPolylineLayers = [];
    }

    const corridorGeoJson = window.routeEngine.getCorridorBuffer(window.deviationDetector.thresholdMeters);
    let polygonCoords = [];
    if (corridorGeoJson && corridorGeoJson.geometry && corridorGeoJson.geometry.coordinates) {
      if (corridorGeoJson.geometry.type === 'MultiPolygon') {
        polygonCoords = corridorGeoJson.geometry.coordinates[0][0];
      } else {
        polygonCoords = corridorGeoJson.geometry.coordinates[0];
      }
    }

    // 绘制淡青色安全走廊缓冲区 (Corridor Buffer)
    if (polygonCoords && polygonCoords.length > 0) {
      try {
        const bmapPolygonPts = polygonCoords.map(pt => new BMapGL.Point(pt[0], pt[1]));
        corridorPolygonLayer = new BMapGL.Polygon(bmapPolygonPts, {
          fillColor: '#0284c7',
          fillOpacity: 0.12,
          strokeColor: '#38bdf8',
          strokeWeight: 1,
          strokeOpacity: 0.8,
          strokeStyle: 'dashed'
        });
        map.addOverlay(corridorPolygonLayer);
      } catch (err) {
        console.warn('走廊多边形绘制异常:', err);
      }
    }

    // 绘制规划基准底层轮廓线
    const lngLats = window.routeEngine.highDenseLine;
    const bmapLinePts = lngLats.map(pt => new BMapGL.Point(pt[0], pt[1]));

    plannedPolylineLayer = new BMapGL.Polyline(bmapLinePts, {
      strokeColor: '#0284c7',
      strokeWeight: 10,
      strokeOpacity: 0.85
    });
    map.addOverlay(plannedPolylineLayer);

    // 绘制真实分段彩色实线
    if (window.routeEngine.getColoredRouteSegments) {
      const segs = window.routeEngine.getColoredRouteSegments();
      segs.forEach(seg => {
        const segPts = seg.path.map(p => new BMapGL.Point(p[0], p[1]));
        const poly = new BMapGL.Polyline(segPts, {
          strokeColor: seg.color,
          strokeWeight: 8,
          strokeOpacity: 0.98
        });
        map.addOverlay(poly);
        trafficPolylineLayers.push(poly);
      });
    }

    // 标记起点与终点
    const startPt = lngLats[0];
    const endPt = lngLats[lngLats.length - 1];

    startOverlay = new CustomHTMLOverlay(
      new BMapGL.Point(startPt[0], startPt[1]),
      '<div class="od-marker-badge start">起</div>',
      { x: -14, y: -14 },
      250
    );
    endOverlay = new CustomHTMLOverlay(
      new BMapGL.Point(endPt[0], endPt[1]),
      '<div class="od-marker-badge end">终</div>',
      { x: -14, y: -14 },
      250
    );
    map.addOverlay(startOverlay);
    map.addOverlay(endOverlay);

    if (bmapLinePts.length > 0 && !isDriverNavActive) {
      map.setViewport(bmapLinePts, { margins: [50, 50, 50, 50] });
    }

    // 同步刷新司机导航路线确认卡片
    const confirmStart = document.getElementById('confirmStartPoint');
    const confirmEnd = document.getElementById('confirmEndPoint');
    const confirmDist = document.getElementById('confirmRouteDist');
    const confirmDur = document.getElementById('confirmDuration');

    if (confirmStart) confirmStart.textContent = window.routeEngine.startName || '广州黄埔港物流中心';
    if (confirmEnd) confirmEnd.textContent = window.routeEngine.endName || '东莞清溪智能产业园';
    if (confirmDist) confirmDist.textContent = `${(window.routeEngine.totalDistanceMeters / 1000).toFixed(1)} km`;
    if (confirmDur) confirmDur.textContent = `${Math.round(window.routeEngine.durationSeconds / 60) || 102}`;
  }

  let currentVehicleHeading = 0;

  // 4. 初始化货车 Marker (百度原生车标 + 车头朝上探路大灯光束)
  function initTruckMarker() {
    const startCoord = window.routeEngine.highDenseLine[0];
    const truckMarkerContent = `
      <div class="nav-vehicle-marker" id="truckMarkerIcon">
        <div class="vehicle-light-beam"></div>
        <div class="vehicle-body">
          <svg viewBox="0 0 40 60" class="truck-svg">
            <rect class="truck-rect" x="8" y="14" width="24" height="42" rx="4" fill="#0284c7" stroke="#38bdf8" stroke-width="2"/>
            <rect x="11" y="18" width="18" height="14" rx="2" fill="#0369a1"/>
            <path d="M11 16 L29 16 L27 10 L13 10 Z" fill="#7dd3fc"/>
            <rect x="13" y="6" width="14" height="4" rx="1" fill="#0284c7"/>
            <ellipse cx="11" cy="7" rx="2" ry="1.5" fill="#fef08a"/>
            <ellipse cx="29" cy="7" rx="2" ry="1.5" fill="#fef08a"/>
            <polygon points="20,1 26,10 14,10" fill="#38bdf8"/>
          </svg>
        </div>
        <div class="vehicle-pulse-ring"></div>
      </div>
    `;

    truckOverlay = new CustomHTMLOverlay(
      new BMapGL.Point(startCoord[0], startCoord[1]),
      truckMarkerContent,
      { x: -26, y: -36 },
      350
    );
    map.addOverlay(truckOverlay);

    // 实际行驶走过的轨迹线 (绿色代表正常，红色代表偏离)
    actualTrackLayer = new BMapGL.Polyline([], {
      strokeColor: '#10b981',
      strokeWeight: 6,
      strokeOpacity: 0.9
    });
    map.addOverlay(actualTrackLayer);
  }

  map.addEventListener('dragstart', () => {
    autoFollow = false;
  });

  // ============================================================
  // 60FPS 丝滑高帧率车辆移动与底图视角补间引擎 (消除跳顿与震颤)
  // ============================================================
  let currentAnimPos = null;
  let currentAnimHeading = 0;
  let animStartPos = null;
  let animTargetPos = null;
  let animStartHeading = 0;
  let animTargetHeading = 0;
  let animStartTime = 0;
  let animDuration = 650;
  let animRafId = null;

  function getShortestAngleDiff(targetAngle, currentAngle) {
    let diff = (targetAngle - currentAngle) % 360;
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;
    return diff;
  }

  function renderVehicleFrame(pos, heading) {
    if (!pos) return;
    currentVehicleHeading = heading;

    // 1. 刷新小车图标位置
    if (truckOverlay) {
      truckOverlay.setPosition(new BMapGL.Point(pos[0], pos[1]));
    }

    // 2. 司机导航模式下车头严格朝上，底图同步顺滑跟随
    if (isDriverNavActive) {
      const vehicleIconEl = document.getElementById('truckMarkerIcon');
      if (vehicleIconEl) vehicleIconEl.style.transform = 'rotate(0deg)';

      if (autoFollow) {
        const forwardOffsetMeters = 180;
        const targetCenter = getForwardOffsetCoord(pos, forwardOffsetMeters, heading);
        map.setCenter(new BMapGL.Point(targetCenter[0], targetCenter[1]));
        map.setHeading(-heading);
        map.setTilt(is3DModeActive ? 42 : 0);
      }
    } else {
      // 调度管理大屏总览模式：正北朝上，车标自身转向
      const vehicleIconEl = document.getElementById('truckMarkerIcon');
      if (vehicleIconEl) vehicleIconEl.style.transform = `rotate(${heading}deg)`;

      if (autoFollow) {
        map.setCenter(new BMapGL.Point(pos[0], pos[1]));
      }
    }

    // 3. 罗盘指南针指针同步旋转
    const compassNeedle = document.getElementById('compassNeedle');
    if (compassNeedle) {
      compassNeedle.style.transform = `rotate(${isDriverNavActive ? heading : 0}deg)`;
    }
  }

  function animLoop(timestamp) {
    if (!animStartPos || !animTargetPos) {
      animRafId = null;
      return;
    }

    const elapsed = timestamp - animStartTime;
    const progress = Math.min(1.0, elapsed / animDuration);

    const curLng = animStartPos[0] + (animTargetPos[0] - animStartPos[0]) * progress;
    const curLat = animStartPos[1] + (animTargetPos[1] - animStartPos[1]) * progress;
    currentAnimPos = [curLng, curLat];

    const angleDiff = getShortestAngleDiff(animTargetHeading, animStartHeading);
    currentAnimHeading = (animStartHeading + angleDiff * progress + 360) % 360;

    renderVehicleFrame(currentAnimPos, currentAnimHeading);

    if (progress < 1.0) {
      animRafId = requestAnimationFrame(animLoop);
    } else {
      animRafId = null;
    }
  }

  function smoothNavigateTo(targetPos, targetHeading, duration = 650) {
    if (!targetPos) return;

    if (!currentAnimPos) {
      currentAnimPos = [...targetPos];
      currentAnimHeading = targetHeading || 0;
      renderVehicleFrame(currentAnimPos, currentAnimHeading);
      return;
    }

    if (animRafId) {
      cancelAnimationFrame(animRafId);
      animRafId = null;
    }

    animStartPos = [...currentAnimPos];
    animTargetPos = [...targetPos];

    if (targetHeading === null || targetHeading === undefined) {
      if (animTargetPos[0] !== animStartPos[0] || animTargetPos[1] !== animStartPos[1]) {
        const b = turf.bearing(turf.point(animStartPos), turf.point(animTargetPos));
        targetHeading = (b + 360) % 360;
      } else {
        targetHeading = currentAnimHeading;
      }
    }

    animStartHeading = currentAnimHeading;
    animTargetHeading = targetHeading;
    animStartTime = performance.now();
    animDuration = Math.max(100, duration);

    animRafId = requestAnimationFrame(animLoop);
  }

  // 初始化地图要素
  drawBaseRouteAndCorridor();
  initTruckMarker();

  // 5. 绑定虚拟仿真器逻辑 (接入 60FPS 平滑导航补间引擎)
  const simulator = new TruckDrivingSimulator(
    window.routeEngine,
    (point, speed, roadName, mode, trafficInfo, heading, duration) => {
      // 记录轨迹点
      actualTrackPoints.push(new BMapGL.Point(point[0], point[1]));
      if (actualTrackPoints.length > 200) actualTrackPoints.shift();
      if (actualTrackLayer) {
        actualTrackLayer.setPath(actualTrackPoints);
      }

      // 实时计算与路线的偏航状态
      const line = window.routeEngine.getGeoJsonLine();
      const checkRes = window.deviationDetector.check(point, line, speed);

      // 上报离线引擎 (断点续传)
      window.offlineStorage.enqueue({
        lat: point[1],
        lng: point[0],
        speed: speed,
        deviationDistance: checkRes.distanceMeters,
        isAlarm: checkRes.isAlarm,
        time: Date.now()
      });

      // 60FPS 顺滑转弯与镜头巡航推进
      smoothNavigateTo(point, heading, duration || 650);

      // 更新 HUD
      updateDriverNavHud(point, speed, roadName, checkRes, trafficInfo);

      // 偏航告警与声音触发
      if (checkRes.isAlarm) {
        showDeviationAlert(checkRes.distanceMeters, checkRes.consecutiveCount);
        if (actualTrackLayer) actualTrackLayer.setStrokeColor('#ef4444');
      } else {
        hideDeviationAlert();
        if (actualTrackLayer) actualTrackLayer.setStrokeColor('#10b981');
      }
    }
  );

  // 6. 司机导航 HUD 动态渲染与路况联动
  function updateDriverNavHud(point, speed, roadName, checkRes, trafficInfo) {
    const hudCurrentSpeed = document.getElementById('hudCurrentSpeed');
    const hudRemainDist = document.getElementById('hudRemainDist');
    const hudOffsetDist = document.getElementById('hudOffsetDist');
    const turnNextRoad = document.getElementById('turnNextRoad');
    const turnAction = document.getElementById('turnAction');
    const turnDistance = document.getElementById('turnDistance');
    const turnIcon = document.getElementById('turnIcon');
    const wormTruckDot = document.getElementById('wormTruckDot');
    const wormRemainKm = document.getElementById('wormRemainKm');

    if (hudCurrentSpeed) hudCurrentSpeed.textContent = speed;
    if (turnNextRoad) turnNextRoad.textContent = roadName || '合规货运通道';

    // 计算剩余里程
    if (window.turf && window.routeEngine.highDenseLine) {
      const endPt = window.routeEngine.highDenseLine[window.routeEngine.highDenseLine.length - 1];
      const distRemainKm = turf.distance(turf.point(point), turf.point(endPt), { units: 'kilometers' });
      if (hudRemainDist) hudRemainDist.textContent = `${distRemainKm.toFixed(1)} km`;
      if (wormRemainKm) wormRemainKm.textContent = `${distRemainKm.toFixed(1)}km`;

      // 更新蚯蚓条进度
      const totalKm = (window.routeEngine.totalDistanceMeters || 102400) / 1000;
      const progress = Math.max(0, Math.min(1, 1 - (distRemainKm / totalKm)));
      if (wormTruckDot) {
        wormTruckDot.style.bottom = `${(progress * 100).toFixed(1)}%`;
      }
    }

    // 偏离安全距显示
    if (hudOffsetDist) {
      if (checkRes.distanceMeters <= window.deviationDetector.thresholdMeters) {
        hudOffsetDist.textContent = `${checkRes.distanceMeters} 米`;
        hudOffsetDist.className = 'stat-val safe';
      } else {
        hudOffsetDist.textContent = `+${checkRes.distanceMeters} 米`;
        hudOffsetDist.className = 'stat-val danger';
      }
    }

    // 模拟前方转弯路标提示
    if (turnAction && turnDistance && turnIcon) {
      if (checkRes.isAlarm) {
        turnIcon.textContent = '⚠️';
        turnAction.textContent = '偏离合规走廊，立即掉头回道';
        turnDistance.textContent = '0.0';
      } else if (speed < 30) {
        turnIcon.textContent = '🛑';
        turnAction.textContent = '路况缓行，保持安全车距';
        turnDistance.textContent = '0.5';
      } else {
        turnIcon.textContent = '⬆️';
        turnAction.textContent = '沿主干高速巡航直行';
        turnDistance.textContent = '2.4';
      }
    }
  }

  // 7. 偏航紧急声光告警展示
  function showDeviationAlert(distance, count) {
    const banner = document.getElementById('deviationAlertBanner');
    const sub = document.getElementById('deviationAlertSub');
    if (banner) banner.style.display = 'flex';
    if (sub) {
      sub.innerHTML = `偏离距离: <strong>${distance}m</strong> (阈值 ${window.deviationDetector.thresholdMeters}m) · 连续 <strong>${count}</strong> 次超限`;
    }

    window.audioAlarm.startDeviationAlarm();
    window.audioAlarm.speak('警告！车辆偏离合规运输走廊，请立即修正航向！');
  }

  function hideDeviationAlert() {
    const banner = document.getElementById('deviationAlertBanner');
    if (banner) banner.style.display = 'none';
    window.audioAlarm.stopAlarm();
  }

  // 8. 司机导航进入与退出控制
  const btnStartDriverNav = document.getElementById('btnStartDriverNav');
  const btnStopDriverNav = document.getElementById('btnStopDriverNav');
  const driverRouteConfirmCard = document.getElementById('driverRouteConfirmCard');
  const driverNavHud = document.getElementById('driverNavHud');
  const navWormBar = document.getElementById('navWormBar');
  const currentModeBadge = document.getElementById('currentModeBadge');

  if (btnStartDriverNav) {
    btnStartDriverNav.addEventListener('click', () => {
      isDriverNavActive = true;
      autoFollow = true;
      is3DModeActive = true;

      if (driverRouteConfirmCard) driverRouteConfirmCard.style.display = 'none';
      if (driverNavHud) driverNavHud.style.display = 'flex';
      if (navWormBar) navWormBar.style.display = 'flex';

      // 调整百度视角为 3D 沉浸倾角
      map.setZoom(17);
      map.setTilt(42);

      const startCoord = window.routeEngine.highDenseLine[0];
      map.setCenter(new BMapGL.Point(startCoord[0], startCoord[1]));

      window.audioAlarm.speak('导航开始，已进入百度合规货车监管走廊，祝您一路平安！');
      
      // 启动标准仿真行车
      simulator.startNormal();
    });
  }

  if (btnStopDriverNav) {
    btnStopDriverNav.addEventListener('click', () => {
      isDriverNavActive = false;
      simulator.stop();
      hideDeviationAlert();

      if (driverRouteConfirmCard) driverRouteConfirmCard.style.display = 'flex';
      if (driverNavHud) driverNavHud.style.display = 'none';
      if (navWormBar) navWormBar.style.display = 'none';

      map.setTilt(0);
      map.setHeading(0);
      map.setZoom(11);
      drawBaseRouteAndCorridor();

      window.audioAlarm.speak('已退出司机导航模式');
    });
  }

  // 9. 视图模式切换 (手机司机导航 vs 调度大屏)
  const btnModeDriver = document.getElementById('btnModeDriver');
  const btnModeDispatch = document.getElementById('btnModeDispatch');
  const desktopPhoneFrameBar = document.getElementById('desktopPhoneFrameBar');

  if (btnModeDriver && btnModeDispatch) {
    btnModeDriver.addEventListener('click', () => {
      btnModeDriver.classList.add('active');
      btnModeDispatch.classList.remove('active');
      document.body.classList.remove('mode-dispatch');
      document.body.classList.add('mode-driver');
      if (desktopPhoneFrameBar) desktopPhoneFrameBar.style.display = 'flex';
      if (!isDriverNavActive && driverRouteConfirmCard) {
        driverRouteConfirmCard.style.display = 'flex';
      }
    });

    btnModeDispatch.addEventListener('click', () => {
      btnModeDispatch.classList.add('active');
      btnModeDriver.classList.remove('active');
      document.body.classList.remove('mode-driver');
      document.body.classList.add('mode-dispatch');
      if (desktopPhoneFrameBar) desktopPhoneFrameBar.style.display = 'none';
      if (driverRouteConfirmCard) driverRouteConfirmCard.style.display = 'none';
      if (driverNavHud) driverNavHud.style.display = 'none';
      if (navWormBar) navWormBar.style.display = 'none';

      map.setTilt(0);
      map.setHeading(0);
      map.setZoom(11);
      drawBaseRouteAndCorridor();
    });
  }

  // 10. 手机物理真实 GPS 驱动模式 (支持室外真车/真机步测)
  const btnRealGpsToggle = document.getElementById('btnRealGpsToggle');
  const btnRealGpsText = document.getElementById('btnRealGpsText');
  const btnRealGpsSub = document.getElementById('btnRealGpsSub');
  const realGpsCoord = document.getElementById('realGpsCoord');
  const realGpsAccuracy = document.getElementById('realGpsAccuracy');
  const realGpsUpdateCountEl = document.getElementById('realGpsUpdateCount');
  const chkAutoFollow = document.getElementById('chkAutoFollow');
  const btnPlanFromCurrentGps = document.getElementById('btnPlanFromCurrentGps');
  const btnCenterGps = document.getElementById('btnCenterGps');
  const btnResetDemoRoute = document.getElementById('btnResetDemoRoute');

  if (btnRealGpsToggle) {
    btnRealGpsToggle.addEventListener('click', () => {
      if (!isRealGpsMode) {
        if (!navigator.geolocation) {
          alert('您的浏览器或设备不支持物理 GPS 定位！');
          return;
        }

        simulator.stop();
        isRealGpsMode = true;
        btnRealGpsToggle.classList.add('active');
        if (btnRealGpsText) btnRealGpsText.textContent = '停止手机真机定位';
        if (btnRealGpsSub) btnRealGpsSub.textContent = '正在实时接收卫星数据并转 BD-09';
        if (currentModeBadge) {
          currentModeBadge.textContent = '🛰️ 真实物理 GPS 模式';
          currentModeBadge.className = 'mode-tag live';
        }

        realGpsWatchId = navigator.geolocation.watchPosition(
          pos => {
            realGpsUpdateCount++;
            if (realGpsUpdateCountEl) realGpsUpdateCountEl.textContent = `${realGpsUpdateCount} 次`;

            const wgsLng = pos.coords.longitude;
            const wgsLat = pos.coords.latitude;
            const accuracy = Math.round(pos.coords.accuracy || 10);
            const speedKmh = pos.coords.speed ? Math.round(pos.coords.speed * 3.6) : 0;
            const heading = pos.coords.heading || 0;

            // 转换 WGS-84 至 BD-09 (百度坐标系)
            let bdCoord = [wgsLng, wgsLat];
            if (window.CoordTransform && window.CoordTransform.wgs84tobd09) {
              bdCoord = window.CoordTransform.wgs84tobd09(wgsLng, wgsLat);
            }

            lastRealCoord = bdCoord;
            lastRealFixTime = Date.now();

            if (realGpsCoord) realGpsCoord.textContent = `${bdCoord[0].toFixed(5)}, ${bdCoord[1].toFixed(5)}`;
            if (realGpsAccuracy) realGpsAccuracy.textContent = `±${accuracy} 米`;

            // 轨迹记录
            actualTrackPoints.push(new BMapGL.Point(bdCoord[0], bdCoord[1]));
            if (actualTrackLayer) actualTrackLayer.setPath(actualTrackPoints);

            // 偏航检查
            const line = window.routeEngine.getGeoJsonLine();
            const checkRes = window.deviationDetector.check(bdCoord, line, speedKmh, accuracy);

            // 离线暂存上报
            window.offlineStorage.enqueue({
              lat: bdCoord[1],
              lng: bdCoord[0],
              speed: speedKmh,
              accuracy: accuracy,
              deviationDistance: checkRes.distanceMeters,
              isAlarm: checkRes.isAlarm,
              time: Date.now()
            });

            smoothNavigateTo(bdCoord, heading, 800);
            updateDriverNavHud(bdCoord, speedKmh, '当前实测道路', checkRes, null);

            if (checkRes.isAlarm) {
              showDeviationAlert(checkRes.distanceMeters, checkRes.consecutiveCount);
            } else {
              hideDeviationAlert();
            }
          },
          err => {
            console.warn('GPS 定位监听异常:', err.message);
          },
          {
            enableHighAccuracy: true,
            maximumAge: 1000,
            timeout: 10000
          }
        );
      } else {
        isRealGpsMode = false;
        if (realGpsWatchId) {
          navigator.geolocation.clearWatch(realGpsWatchId);
          realGpsWatchId = null;
        }
        btnRealGpsToggle.classList.remove('active');
        if (btnRealGpsText) btnRealGpsText.textContent = '开启手机真实 GPS 定位';
        if (btnRealGpsSub) btnRealGpsSub.textContent = '读取手机芯片真实定位并实时转换 BD-09';
        if (currentModeBadge) {
          currentModeBadge.textContent = '🎮 仿真推流模式';
          currentModeBadge.className = 'mode-tag sim';
        }
      }
    });
  }

  if (chkAutoFollow) {
    chkAutoFollow.addEventListener('change', e => {
      autoFollow = e.target.checked;
    });
  }

  if (btnCenterGps) {
    btnCenterGps.addEventListener('click', () => {
      if (lastRealCoord) {
        autoFollow = true;
        map.setCenter(new BMapGL.Point(lastRealCoord[0], lastRealCoord[1]));
        if (chkAutoFollow) chkAutoFollow.checked = true;
      } else {
        alert('尚未获取到手机有效定位坐标');
      }
    });
  }

  if (btnPlanFromCurrentGps) {
    btnPlanFromCurrentGps.addEventListener('click', () => {
      if (!lastRealCoord) {
        alert('请先开启手机真实 GPS 定位获取当前位置！');
        return;
      }
      window.routeEngine.generateRouteFromCurrentPosition(lastRealCoord[0], lastRealCoord[1], 2.5, 60);
      actualTrackPoints.length = 0;
      drawBaseRouteAndCorridor();
      window.deviationDetector.reset();
      window.audioAlarm.speak('已基于手机当前位置生成 2.5 公里测试安全走廊');
    });
  }

  if (btnResetDemoRoute) {
    btnResetDemoRoute.addEventListener('click', () => {
      window.routeEngine.resetToDefaultDemoRoute();
      actualTrackPoints.length = 0;
      drawBaseRouteAndCorridor();
      window.deviationDetector.reset();
      window.audioAlarm.speak('已恢复广深默认演示基线');
    });
  }

  // 11. 虚拟仿真控制器事件绑定
  const btnDriveNormal = document.getElementById('btnDriveNormal');
  const btnDriveDeviate = document.getElementById('btnDriveDeviate');
  const btnSimTunnel = document.getElementById('btnSimTunnel');
  const btnResetSim = document.getElementById('btnResetSim');

  if (btnDriveNormal) {
    btnDriveNormal.addEventListener('click', () => {
      if (isRealGpsMode && btnRealGpsToggle) btnRealGpsToggle.click();
      simulator.startNormal();
      window.audioAlarm.speak('启动合规道路正常行驶模拟');
    });
  }

  if (btnDriveDeviate) {
    btnDriveDeviate.addEventListener('click', () => {
      if (isRealGpsMode && btnRealGpsToggle) btnRealGpsToggle.click();
      simulator.startDeviate();
      window.audioAlarm.speak('模拟车辆驶入未经审批的非标路线');
    });
  }

  if (btnSimTunnel) {
    btnSimTunnel.addEventListener('click', () => {
      if (isRealGpsMode && btnRealGpsToggle) btnRealGpsToggle.click();
      simulator.startTunnelOffline();
      window.audioAlarm.speak('车辆进入隧道，模拟通信中断与本地缓存');
    });
  }

  if (btnResetSim) {
    btnResetSim.addEventListener('click', () => {
      simulator.reset();
      hideDeviationAlert();
      actualTrackPoints.length = 0;
      if (actualTrackLayer) actualTrackLayer.setPath([]);
      const startCoord = window.routeEngine.highDenseLine[0];
      if (truckOverlay) truckOverlay.setPosition(new BMapGL.Point(startCoord[0], startCoord[1]));
      map.setCenter(new BMapGL.Point(startCoord[0], startCoord[1]));
      window.audioAlarm.speak('仿真状态已复位重置');
    });
  }

  // 12. 离线存储管道与网络状态回调
  const netStatusDot = document.getElementById('netStatusDot');
  const netStatusText = document.getElementById('netStatusText');
  const uploadedCountEl = document.getElementById('uploadedCount');
  const offlineQueueCountEl = document.getElementById('offlineQueueCount');
  const lastUploadTag = document.getElementById('lastUploadTag');
  const uploadPacketJson = document.getElementById('uploadPacketJson');
  const packetStatus = document.getElementById('packetStatus');

  window.offlineStorage.onQueueChange = (queueLength, totalUploaded, batch) => {
    if (offlineQueueCountEl) offlineQueueCountEl.textContent = `${queueLength} 条`;
    if (uploadedCountEl) uploadedCountEl.textContent = `${totalUploaded} 次`;

    const isOnline = window.offlineStorage.isOnline;
    if (netStatusDot) {
      netStatusDot.className = isOnline ? 'status-indicator online' : 'status-indicator offline';
    }
    if (netStatusText) {
      netStatusText.textContent = isOnline ? (queueLength > 0 ? '网络恢复 (补传中)' : '网络正常') : '无信号/弱网暂存';
    }
    if (lastUploadTag) {
      lastUploadTag.textContent = isOnline ? '正常上报' : '本地队列';
      lastUploadTag.className = isOnline ? 'net-tag ok' : 'net-tag warn';
    }
    if (batch && batch.length > 0 && uploadPacketJson) {
      uploadPacketJson.textContent = JSON.stringify(batch[batch.length - 1], null, 2);
    }
  };

  // 13. 偏航距离阈值滑动条
  const thresholdRange = document.getElementById('thresholdRange');
  const thresholdVal = document.getElementById('thresholdVal');

  if (thresholdRange && thresholdVal) {
    thresholdRange.addEventListener('input', e => {
      const v = Number(e.target.value);
      thresholdVal.textContent = `${v} 米`;
      window.deviationDetector.setThreshold(v);
      drawBaseRouteAndCorridor();
    });

    document.querySelectorAll('.setting-shortcuts .btn-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const val = btn.getAttribute('data-val');
        if (val) {
          thresholdRange.value = val;
          thresholdVal.textContent = `${val} 米`;
          window.deviationDetector.setThreshold(Number(val));
          drawBaseRouteAndCorridor();
        }
      });
    });
  }

  // 14. 弹窗多方案切换 (方案1 / 方案2 / 方案3 胶囊)
  const candidateCapsules = document.querySelectorAll('.candidate-capsule');
  candidateCapsules.forEach(cap => {
    cap.addEventListener('click', () => {
      candidateCapsules.forEach(c => c.classList.remove('active'));
      cap.classList.add('active');
      const idx = Number(cap.getAttribute('data-candidate-idx') || 0);
      window.routeEngine.selectCandidateRoute(idx);
      actualTrackPoints.length = 0;
      drawBaseRouteAndCorridor();
      window.deviationDetector.reset();
      window.audioAlarm.speak(`已切换为${window.routeEngine.candidateRoutes[idx].name}`);
    });
  });

  // 15. 路线更换弹窗交互 (Modal)
  const btnOpenRouteSwitchModal = document.getElementById('btnOpenRouteSwitchModal');
  const routeSwitchModal = document.getElementById('routeSwitchModal');
  const btnCloseRouteModal = document.getElementById('btnCloseRouteModal');
  const modalBackdrop = document.getElementById('modalBackdrop');
  const tabPresetRoutes = document.getElementById('tabPresetRoutes');
  const tabCustomRoute = document.getElementById('tabCustomRoute');
  const contentPresetRoutes = document.getElementById('contentPresetRoutes');
  const contentCustomRoute = document.getElementById('contentCustomRoute');
  const confirmOdClickArea = document.getElementById('confirmOdClickArea');

  function openRouteModal() {
    if (routeSwitchModal) routeSwitchModal.style.display = 'flex';
  }
  function closeRouteModal() {
    if (routeSwitchModal) routeSwitchModal.style.display = 'none';
  }

  if (btnOpenRouteSwitchModal) btnOpenRouteSwitchModal.addEventListener('click', openRouteModal);
  if (confirmOdClickArea) confirmOdClickArea.addEventListener('click', openRouteModal);
  if (btnCloseRouteModal) btnCloseRouteModal.addEventListener('click', closeRouteModal);
  if (modalBackdrop) modalBackdrop.addEventListener('click', closeRouteModal);

  if (tabPresetRoutes && tabCustomRoute) {
    tabPresetRoutes.addEventListener('click', () => {
      tabPresetRoutes.classList.add('active');
      tabCustomRoute.classList.remove('active');
      if (contentPresetRoutes) contentPresetRoutes.style.display = 'block';
      if (contentCustomRoute) contentCustomRoute.style.display = 'none';
    });

    tabCustomRoute.addEventListener('click', () => {
      tabCustomRoute.classList.add('active');
      tabPresetRoutes.classList.remove('active');
      if (contentPresetRoutes) contentPresetRoutes.style.display = 'none';
      if (contentCustomRoute) contentCustomRoute.style.display = 'block';
    });
  }

  // 预设路线切换按钮
  document.querySelectorAll('.btn-apply-preset').forEach(btn => {
    btn.addEventListener('click', e => {
      const routeId = btn.getAttribute('data-route-id');
      if (routeId) {
        window.routeEngine.loadPresetRoute(routeId);
        actualTrackPoints.length = 0;
        drawBaseRouteAndCorridor();
        window.deviationDetector.reset();
        closeRouteModal();
        window.audioAlarm.speak(`已成功切换到目标货运路线`);
      }
    });
  });

  // 16. 调用百度 JS API GL 官方在线算路
  const btnCallBaiduApi = document.getElementById('btnCallBaiduApi');
  const btnModalSubmitRoute = document.getElementById('btnModalSubmitRoute');
  const startPointInput = document.getElementById('startPointInput');
  const endPointInput = document.getElementById('endPointInput');
  const modalStartInput = document.getElementById('modalStartInput');
  const modalEndInput = document.getElementById('modalEndInput');

  async function triggerBaiduRoutePlan(start, end) {
    try {
      window.audioAlarm.speak('正在调取百度地图官方引擎计算合规货车路径');
      const res = await window.routeEngine.planWithBaiduJsApi(start, end);
      actualTrackPoints.length = 0;
      drawBaseRouteAndCorridor();
      window.deviationDetector.reset();
      closeRouteModal();
      window.audioAlarm.speak(`算路成功，全程${(res.distanceMeters / 1000).toFixed(1)}公里`);
    } catch (err) {
      alert(`百度规划失败: ${err.message}`);
    }
  }

  if (btnCallBaiduApi) {
    btnCallBaiduApi.addEventListener('click', () => {
      const s = startPointInput ? startPointInput.value.trim() : '广州黄埔港物流中心';
      const e = endPointInput ? endPointInput.value.trim() : '东莞清溪智能产业园';
      triggerBaiduRoutePlan(s, e);
    });
  }

  if (btnModalSubmitRoute) {
    btnModalSubmitRoute.addEventListener('click', () => {
      const s = modalStartInput ? modalStartInput.value.trim() : '广州黄埔港物流中心';
      const e = modalEndInput ? modalEndInput.value.trim() : '东莞清溪智能产业园';
      triggerBaiduRoutePlan(s, e);
    });
  }

  // 17. 唤起手机百度地图 App
  const btnLaunchBaiduApp = document.getElementById('btnLaunchBaiduApp');
  if (btnLaunchBaiduApp) {
    btnLaunchBaiduApp.addEventListener('click', () => {
      const line = window.routeEngine.highDenseLine;
      const startPt = line[0];
      const endPt = line[line.length - 1];
      const url = window.routeEngine.getBaiduAppLaunchUrl(
        startPt,
        endPt,
        window.routeEngine.startName || '起运地',
        window.routeEngine.endName || '目的地'
      );
      window.location.href = url;
    });
  }

  // 18. 地图选点功能
  let isPickingStart = false;
  let isPickingEnd = false;
  const btnPickStartOnMap = document.getElementById('btnPickStartOnMap');
  const btnPickEndOnMap = document.getElementById('btnPickEndOnMap');

  if (btnPickStartOnMap) {
    btnPickStartOnMap.addEventListener('click', () => {
      isPickingStart = true;
      isPickingEnd = false;
      alert('请在地图上点击目标位置作为【起点】');
    });
  }
  if (btnPickEndOnMap) {
    btnPickEndOnMap.addEventListener('click', () => {
      isPickingEnd = true;
      isPickingStart = false;
      alert('请在地图上点击目标位置作为【目的地】');
    });
  }

  map.addEventListener('click', e => {
    if (isPickingStart && e.latlng) {
      const pt = [Number(e.latlng.lng.toFixed(6)), Number(e.latlng.lat.toFixed(6))];
      if (startPointInput) startPointInput.value = `${pt[0]}, ${pt[1]}`;
      if (modalStartInput) modalStartInput.value = `${pt[0]}, ${pt[1]}`;
      isPickingStart = false;
      window.audioAlarm.speak('起点已选定');
    } else if (isPickingEnd && e.latlng) {
      const pt = [Number(e.latlng.lng.toFixed(6)), Number(e.latlng.lat.toFixed(6))];
      if (endPointInput) endPointInput.value = `${pt[0]}, ${pt[1]}`;
      if (modalEndInput) modalEndInput.value = `${pt[0]}, ${pt[1]}`;
      isPickingEnd = false;
      window.audioAlarm.speak('目的地已选定');
    }
  });

  // 19. 罗盘与居中锁定按钮
  const btnToggleHeadingUp = document.getElementById('btnToggleHeadingUp');
  if (btnToggleHeadingUp) {
    btnToggleHeadingUp.addEventListener('click', () => {
      autoFollow = true;
      if (isDriverNavActive) {
        map.setHeading(-currentVehicleHeading);
        map.setTilt(42);
      } else {
        map.setHeading(0);
        map.setTilt(0);
      }
      if (currentAnimPos) {
        map.setCenter(new BMapGL.Point(currentAnimPos[0], currentAnimPos[1]));
      }
    });
  }

  // 20. 静音切换按钮
  const btnToggleMute = document.getElementById('btnToggleMute');
  const muteIcon = document.getElementById('muteIcon');
  if (btnToggleMute) {
    btnToggleMute.addEventListener('click', () => {
      const isMuted = window.audioAlarm.toggleMute();
      if (muteIcon) muteIcon.textContent = isMuted ? '🔇' : '🔊';
    });
  }

  // 21. 侧边栏展开/收起 (移动端适配)
  const btnToggleSidebar = document.getElementById('btnToggleSidebar');
  const btnCloseSidebar = document.getElementById('btnCloseSidebar');
  const sidebarBackdrop = document.getElementById('sidebarBackdrop');
  const controlPanel = document.getElementById('controlPanel');

  function openSidebar() {
    if (controlPanel) controlPanel.classList.add('mobile-open');
    if (sidebarBackdrop) sidebarBackdrop.classList.add('show');
  }
  function closeSidebar() {
    if (controlPanel) controlPanel.classList.remove('mobile-open');
    if (sidebarBackdrop) sidebarBackdrop.classList.remove('show');
  }

  if (btnToggleSidebar) btnToggleSidebar.addEventListener('click', openSidebar);
  if (btnCloseSidebar) btnCloseSidebar.addEventListener('click', closeSidebar);
  if (sidebarBackdrop) sidebarBackdrop.addEventListener('click', closeSidebar);

  // 22. 桌面端手机尺寸切换 (390x844 vs 铺满)
  const btnFrameSim = document.getElementById('btnFrameSim');
  const btnFrameFull = document.getElementById('btnFrameFull');
  const mainEl = document.querySelector('.app-main');

  if (btnFrameSim && btnFrameFull && mainEl) {
    btnFrameSim.addEventListener('click', () => {
      btnFrameSim.classList.add('active');
      btnFrameFull.classList.remove('active');
      mainEl.classList.remove('frame-full');
      mainEl.classList.add('frame-sim');
    });

    btnFrameFull.addEventListener('click', () => {
      btnFrameFull.classList.add('active');
      btnFrameSim.classList.remove('active');
      mainEl.classList.remove('frame-sim');
      mainEl.classList.add('frame-full');
    });
  }

  // 23. 恢复默认路线按钮
  const btnResetToDefaultRoute = document.getElementById('btnResetToDefaultRoute');
  if (btnResetToDefaultRoute) {
    btnResetToDefaultRoute.addEventListener('click', () => {
      window.routeEngine.resetToDefaultDemoRoute();
      actualTrackPoints.length = 0;
      drawBaseRouteAndCorridor();
      window.deviationDetector.reset();
      window.audioAlarm.speak('已重置回广深基准路线');
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initBaiduApp);
} else {
  initBaiduApp();
}
