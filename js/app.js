/**
 * 智能货运监控平台主调度程序 (App Main Controller - 移动端/真机适配版)
 */
document.addEventListener('DOMContentLoaded', () => {
  // 1. 初始化高德开放平台官方原生 WebGL 3D 矢量地图 (高精 GCJ-02，全景支持 3D 导航与车头朝上透视)
  const map = new AMap.Map('map', {
    viewMode: '3D',
    pitch: 0,
    rotation: 0,
    zoom: 11,
    center: [113.8000, 22.9500]
  });

  // 1.1 开启高德开放平台官方原生实时路况图层 (AMap.TileLayer.Traffic)
  let trafficLayer = null;
  let isTrafficVisible = true;
  try {
    if (window.AMap && AMap.TileLayer && AMap.TileLayer.Traffic) {
      trafficLayer = new AMap.TileLayer.Traffic({
        zIndex: 10,
        opacity: 0.85,
        autoRefresh: true,
        interval: 120
      });
      map.add(trafficLayer);
    }
  } catch (e) {
    console.warn('高德实时路况图层初始化异常:', e);
  }

  // 2. 地图图层变量定义
  let plannedPolylineLayer = null;
  let trafficPolylineLayers = [];
  let corridorPolygonLayer = null;
  let actualTrackLayer = null;
  let truckMarker = null;
  let accuracyCircle = null;
  let startMarker = null;
  let endMarker = null;

  const actualTrackPoints = [];

  // 手机真机 GPS 状态变量
  let isRealGpsMode = false;
  let isDriverNavActive = false;
  let realGpsWatchId = null;
  let realGpsUpdateCount = 0;
  let lastRealCoord = null;
  let lastRealFixTime = 0;        // 最近一次拿到真机有效定位的时间戳
  let gpsErrorTipShown = false;   // 信号弱/超时类错误只弹一次提示
  let autoFollow = true;
  let is3DModeActive = true; // 导航模式默认启用 3D 沉浸车头朝上透视
  let lastTrafficStatus = 'smooth';

  // 计算沿车辆当前航向角向前偏置的中心点坐标 (高德经典车载导航下沉视角核心：让车标下沉至屏幕约 70% 处，上方完整展现前方具体导航线路)
  function getForwardOffsetCoord(lngLat, offsetMeters = 180, headingDeg = 0) {
    if (!lngLat) return [113.483120, 23.098800];
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

  // 3. 绘制货车规划基准路线与安全走廊 (高精贴地道路折线 + 高亮荧光导航引导带)
  function drawBaseRouteAndCorridor() {
    if (plannedPolylineLayer) map.remove(plannedPolylineLayer);
    if (corridorPolygonLayer) map.remove(corridorPolygonLayer);
    if (startMarker) map.remove(startMarker);
    if (endMarker) map.remove(endMarker);

    const corridorGeoJson = window.routeEngine.getCorridorBuffer(window.deviationDetector.thresholdMeters);
    let polygonCoords = [];
    if (corridorGeoJson && corridorGeoJson.geometry && corridorGeoJson.geometry.coordinates) {
      polygonCoords = corridorGeoJson.geometry.coordinates[0];
    }

    // 绘制淡青色安全走廊缓冲区 (Corridor Buffer)
    corridorPolygonLayer = new AMap.Polygon({
      path: polygonCoords,
      fillColor: '#0284c7',
      fillOpacity: 0.06,
      strokeColor: '#38bdf8',
      strokeWeight: 1,
      strokeStyle: 'dashed',
      strokeDasharray: [6, 6]
    });
    map.add(corridorPolygonLayer);

    // 绘制规划基准底层轮廓外发光边框线 (保证任何地图背景下具体导航线都极度醒目)
    const lngLats = window.routeEngine.highDenseLine; // [[lng, lat], ...]
    if (trafficPolylineLayers.length) {
      map.remove(trafficPolylineLayers);
      trafficPolylineLayers = [];
    }

    plannedPolylineLayer = new AMap.Polyline({
      path: lngLats,
      isOutline: true,
      outlineColor: '#0f172a',
      borderWeight: 2,
      strokeColor: '#0284c7',
      strokeOpacity: 0.9,
      strokeWeight: 12,
      strokeLineJoin: 'round',
      strokeLineCap: 'round',
      showDir: true,
      zIndex: 40
    });
    map.add(plannedPolylineLayer);

    // 绘制高德真实分段路况彩色实线 (高亮荧光色 + 白色发光箭头导航带)
    if (window.routeEngine.getColoredRouteSegments) {
      const segs = window.routeEngine.getColoredRouteSegments();
      segs.forEach(seg => {
        const poly = new AMap.Polyline({
          path: seg.path,
          strokeColor: seg.color, // '#00c06d' 畅通, '#ffaa00' 缓行, '#ef4444' 拥堵
          strokeOpacity: 0.98,
          strokeWeight: 9,
          strokeLineJoin: 'round',
          strokeLineCap: 'round',
          showDir: true,
          zIndex: 45
        });
        map.add(poly);
        trafficPolylineLayers.push(poly);
      });
    }

    // 标记起点与终点
    const startPt = lngLats[0];
    const endPt = lngLats[lngLats.length - 1];

    startMarker = new AMap.Marker({
      position: startPt,
      content: '<div class="od-marker-badge start">起</div>',
      offset: new AMap.Pixel(-13, -13),
      title: `起运地: ${window.routeEngine.startName || '广州黄埔港物流中心'}`
    });

    endMarker = new AMap.Marker({
      position: endPt,
      content: '<div class="od-marker-badge end">终</div>',
      offset: new AMap.Pixel(-13, -13),
      title: `目的地: ${window.routeEngine.endName || '东莞清溪智能产业园'}`
    });
    map.add([startMarker, endMarker]);

    if (document.body.classList.contains('mode-driver') && !isDriverNavActive) {
      map.setFitView([plannedPolylineLayer], false, [60, 35, 260, 35]);
    } else {
      map.setFitView([plannedPolylineLayer], false, [50, 50, 50, 50]);
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
  let lastVehicleCoord = null;

  // 4. 初始化货车 Marker (高德原生车标 + 车头朝上探路大灯光束)
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

    truckMarker = new AMap.Marker({
      position: startCoord,
      content: truckMarkerContent,
      offset: new AMap.Pixel(-26, -36),
      angle: 0
    });
    map.add(truckMarker);

    // 实际行驶走过的轨迹线 (绿色代表正常，红色代表偏离)
    actualTrackLayer = new AMap.Polyline({
      path: [],
      strokeColor: '#10b981',
      strokeOpacity: 0.9,
      strokeWeight: 6,
      strokeLineJoin: 'round'
    });
    map.add(actualTrackLayer);
  }

  // 用户手动拖拽或滑动地图时，暂停自动强行拉回，方便司机自由浏览路况
  map.on('dragstart', () => {
    autoFollow = false;
  });

  // ============================================================
  // 60FPS 丝滑高帧率车辆移动与底图视角补间引擎 (彻底消除跳顿与震颤)
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
    truckMarker.setPosition(pos);

    // 2. 核心：司机导航模式下车头严格朝上，底图同步顺滑跟随
    if (isDriverNavActive) {
      const vehicleIconEl = document.getElementById('truckMarkerIcon');
      if (vehicleIconEl) vehicleIconEl.style.transform = 'rotate(0deg)';

      if (autoFollow) {
        // 下沉居中视角：中心前置 180 米，完美露出前方 500+ 米导航线路
        const forwardOffsetMeters = 180;
        const targetCenter = getForwardOffsetCoord(pos, forwardOffsetMeters, heading);
        map.setCenter(targetCenter);
        map.setRotation(-heading);
        map.setPitch(is3DModeActive ? 42 : 0);
      }
    } else {
      // 调度管理大屏总览模式：正北朝上，车标自身转向
      const vehicleIconEl = document.getElementById('truckMarkerIcon');
      if (vehicleIconEl) vehicleIconEl.style.transform = `rotate(${heading}deg)`;

      if (autoFollow) {
        map.setCenter(pos);
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

    // 1. 位置线性平滑插值 (60FPS 连贯前进，消除离散跳顿)
    const curLng = animStartPos[0] + (animTargetPos[0] - animStartPos[0]) * progress;
    const curLat = animStartPos[1] + (animTargetPos[1] - animStartPos[1]) * progress;
    currentAnimPos = [curLng, curLat];

    // 2. 航向角最短角差平滑插值 (柔和转弯，杜绝晃动震颤)
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

  function updateVehicleOrientationAndMap(curLngLat, prevLngLat) {
    smoothNavigateTo(curLngLat, null, 400);
  }

  // 初始化地图要素
  drawBaseRouteAndCorridor();
  initTruckMarker();

  // 5. 绑定虚拟仿真器逻辑 (接入 60FPS 平滑导航补间引擎)
  const simulator = new TruckDrivingSimulator(
    window.routeEngine,
    // onTick 逐点上报与遥测
    (point, speed, roadName, mode, trafficInfo, heading, duration) => {
      // 真机 GPS 最近 10 秒内有有效定位时以真机为准，忽略虚拟推流；
      // 若真机迟迟拿不到定位 (室内/桌面浏览器)，仿真推流继续作为演示兜底
      if (isRealGpsMode && Date.now() - lastRealFixTime < 10000) return;
      const lat = point[1];
      const lng = point[0];

      // 60FPS 丝滑推进车辆与旋转底图 (无任何跳跃与抖动)
      smoothNavigateTo(point, heading, duration || 650);

      // 记录实际行车轨迹
      actualTrackPoints.push([lng, lat]);
      actualTrackLayer.setPath(actualTrackPoints);

      // 执行点到折线垂线距离判定 (Turf.js)
      const res = window.deviationDetector.check(point, window.routeEngine.getGeoJsonLine(), speed);

      // 上报写入离线暂存转发引擎
      window.offlineStorage.enqueue({
        lat, lng, speed,
        timestamp: Date.now(),
        distanceMeters: res.distanceMeters,
        source: 'SIMULATOR'
      });

      // 刷新 HUD 仪表盘与高德真实路况
      updateHud(speed, res.distanceMeters, roadName, res.isAlarm, mode, trafficInfo);

      // 状态判断
      if (res.isAlarm) {
        triggerDeviationAlarmUI(res.distanceMeters, roadName);
      } else {
        dismissDeviationAlarmUI();
      }
    }
  );

  // 6. 📱 手机真机实时 GPS 定位引擎 (核心实现)
  function startRealGpsMode() {
    if (simulator) simulator.stop();

    if (!navigator.geolocation) {
      showGeoTipModal('当前浏览器或操作系统不支持 Geolocation 原生地理定位 API。');
      return;
    }

    // 提示非 HTTPS 安全上下文
    if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      appendLog('warn', '【安全提示】移动端浏览器通过局域网 HTTP 访问可能会被系统限制 GPS，如遇失败请通过 HTTPS 或在浏览器设置中开启授权。');
    }

    isRealGpsMode = true;
    updateModeUI(true);

    appendLog('info', '【真机模式】已启动手机物理 GPS 实时定位监听 (watchPosition)...');

    realGpsWatchId = navigator.geolocation.watchPosition(
      handleRealGpsPosition,
      handleRealGpsError,
      {
        enableHighAccuracy: true, // 强制调用高精度 GPS 芯片 (而非 Wi-Fi 粗定位)
        maximumAge: 0,
        timeout: 15000
      }
    );
  }

  function stopRealGpsMode() {
    if (realGpsWatchId !== null) {
      navigator.geolocation.clearWatch(realGpsWatchId);
      realGpsWatchId = null;
    }
    isRealGpsMode = false;
    updateModeUI(false);

    if (accuracyCircle) {
      map.remove(accuracyCircle);
      accuracyCircle = null;
    }

    appendLog('info', '【真机模式】已停止手机 GPS 监听，已切换回待机状态。');
  }

  function handleRealGpsPosition(pos) {
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    const accuracy = Math.round(pos.coords.accuracy || 0);
    const rawSpeed = pos.coords.speed; // 米/秒
    const speed = (rawSpeed !== null && !isNaN(rawSpeed) && rawSpeed > 0) ? Math.round(rawSpeed * 3.6) : 0;

    realGpsUpdateCount++;

    // 更新面板上的手机遥测数据
    document.getElementById('realGpsCoord').textContent = `${lng.toFixed(5)}, ${lat.toFixed(5)}`;
    document.getElementById('realGpsAccuracy').textContent = `±${accuracy} 米`;
    document.getElementById('realGpsUpdateCount').textContent = `${realGpsUpdateCount} 次`;

    const isFirstPoint = (lastRealCoord === null);
    const prevRealCoord = lastRealCoord;
    lastRealCoord = [lng, lat];
    lastRealFixTime = Date.now();

    // 真机一旦拿到有效定位，停止仿真推流，避免两路数据源同时驱动车标
    if (simulator && simulator.timer) simulator.stop();

    if (isFirstPoint) {
      const firstDist = turf.pointToLineDistance(turf.point([lng, lat]), window.routeEngine.getGeoJsonLine(), { units: 'kilometers' }) * 1000;
      if (firstDist > 5000) {
        if (isDriverNavActive) {
          // 导航中：绝不能悄悄替换调度下发的路线，否则偏航判断失去意义 —— 只提示司机
          const km = (firstDist / 1000).toFixed(1);
          appendLog('warn', `【位置提示】当前距规划路线约 ${km} 公里，请先前往起点：${window.routeEngine.startName}`);
          window.audioAlarm.speak(`您当前距离规划路线约 ${km} 公里，请先前往起点`);
        } else {
          // 非导航的测试场景：沿用旧行为，以当前位置生成实测走廊
          appendLog('success', `【自动适配】检测到手机当前位于 [${lng.toFixed(4)}, ${lat.toFixed(4)}]，已自动以当前位置为起点生成 2.5km 实测走廊！`);
          window.routeEngine.generateRouteFromCurrentPosition(lng, lat, 2.5);
          window.deviationDetector.reset();
          drawBaseRouteAndCorridor();
          map.setCenter([lng, lat]);
          map.setZoom(16);
        }
      } else if (!isDriverNavActive) {
        map.setCenter([lng, lat]);
        map.setZoom(16);
      }
    }

    // 绘制手机 GPS 精度光环
    if (accuracyCircle) {
      accuracyCircle.setCenter([lng, lat]);
      accuracyCircle.setRadius(accuracy);
    } else {
      accuracyCircle = new AMap.Circle({
        center: [lng, lat],
        radius: accuracy,
        strokeColor: '#38bdf8',
        strokeWeight: 1,
        fillColor: '#0284c7',
        fillOpacity: 0.15
      });
      map.add(accuracyCircle);
    }

    // 记录实际行进轨迹
    actualTrackPoints.push([lng, lat]);
    actualTrackLayer.setPath(actualTrackPoints);

    // 航向：优先用手机芯片给出的 heading (行驶中才有效)；
    // 静止或低速时 GPS 漂移会导致方向乱转，此时保持上一次航向不变
    const deviceHeading = pos.coords.heading;
    const movedMeters = prevRealCoord
      ? turf.distance(turf.point(prevRealCoord), turf.point([lng, lat]), { units: 'kilometers' }) * 1000
      : 0;
    let gpsHeading = currentAnimHeading;
    if (deviceHeading !== null && !isNaN(deviceHeading) && rawSpeed > 1.5) {
      gpsHeading = deviceHeading;
    } else if (prevRealCoord && movedMeters > Math.max(5, accuracy * 0.5)) {
      gpsHeading = (turf.bearing(turf.point(prevRealCoord), turf.point([lng, lat])) + 360) % 360;
    }
    // GPS 约 1 秒一次，用 900ms 补间实现平滑跟随
    smoothNavigateTo([lng, lat], gpsHeading, 900);

    // 执行点到折线垂线距离判定 (精度太差的点不计入连续偏航计数，防止室内/高楼漂移误报)
    const res = window.deviationDetector.check([lng, lat], window.routeEngine.getGeoJsonLine(), speed, accuracy);

    // 上报写入离线暂存转发引擎 (触发实时云端上传)
    window.offlineStorage.enqueue({
      lat,
      lng,
      speed,
      accuracy,
      timestamp: Date.now(),
      distanceMeters: res.distanceMeters,
      isDeviated: res.isAlarm,
      heading: Math.round(gpsHeading),
      source: 'MOBILE_HARDWARE_GPS'
    });

    // 刷新车载 HUD
    const roadDesc = `实测坐标 (${lng.toFixed(4)}, ${lat.toFixed(4)}) 精度:±${accuracy}m`;
    updateHud(speed, res.distanceMeters, roadDesc, res.isAlarm, 'REAL');

    // 偏航警报判断
    if (res.isAlarm) {
      triggerDeviationAlarmUI(res.distanceMeters, `实地偏离已超标 (±${accuracy}m)`);
    } else {
      dismissDeviationAlarmUI();
    }

    // 记录实时位置日志
    appendLog('info', `【📡 手机位置更新 #${realGpsUpdateCount}】经纬度:[${lng.toFixed(4)}, ${lat.toFixed(4)}] 精度:±${accuracy}m 速度:${speed}km/h 距规划线:${res.distanceMeters}m`);
  }

  function handleRealGpsError(err) {
    let errMsg = '定位未知错误';
    switch (err.code) {
      case 1: // PERMISSION_DENIED
        errMsg = '手机或浏览器拒绝了定位权限，请在手机浏览器设置中允许该页面获取当前位置。';
        break;
      case 2: // POSITION_UNAVAILABLE
        errMsg = '手机当前无法获取 GPS 卫星信号（可能在室内或地下室），请移步窗边或室外测试。';
        break;
      case 3: // TIMEOUT
        errMsg = '获取手机定位超时，正在继续重试...';
        break;
    }
    appendLog('alarm', `【GPS定位失败】${errMsg} (错误码: ${err.code})`);
    if (err.code === 1) {
      // 只有权限被拒才停止监听；信号弱/超时是暂时的，watchPosition 会继续自动重试
      showGeoTipModal(errMsg);
      stopRealGpsMode();
    } else if (!gpsErrorTipShown) {
      gpsErrorTipShown = true;
      showGeoTipModal(errMsg);
    }
  }

  function updateModeUI(isReal) {
    const btnReal = document.getElementById('btnRealGpsToggle');
    const btnText = document.getElementById('btnRealGpsText');
    const btnSub = document.getElementById('btnRealGpsSub');
    const badge = document.getElementById('currentModeBadge');
    const hudSource = document.getElementById('hudSourceBadge');
    const mobileBtn = document.getElementById('btnMobileToggleGps');
    const mobileBtnTxt = document.getElementById('mobileGpsBtnTxt');

    if (isReal) {
      btnReal.classList.add('active');
      btnText.textContent = '🛑 停止手机真实 GPS 定位';
      btnSub.textContent = '当前正在实时追踪手机硬件坐标与上报';
      badge.textContent = '📱 手机真机实时模式';
      badge.className = 'mode-tag real';
      hudSource.textContent = '手机物理GPS';
      if (mobileBtn) {
        mobileBtn.classList.add('active');
        mobileBtnTxt.textContent = '停止定位';
      }
    } else {
      btnReal.classList.remove('active');
      btnText.textContent = '开启手机真实 GPS 定位';
      btnSub.textContent = '读取手机芯片真实定位并实时上报';
      badge.textContent = '🎮 仿真推流模式';
      badge.className = 'mode-tag sim';
      hudSource.textContent = '虚拟推流';
      if (mobileBtn) {
        mobileBtn.classList.remove('active');
        mobileBtnTxt.textContent = '开启定位';
      }
    }
  }

  function showGeoTipModal(msg) {
    const modal = document.getElementById('geoTipModal');
    const msgEl = document.getElementById('geoTipMessage');
    if (msg) msgEl.textContent = msg;
    modal.style.display = 'flex';
  }

  let lastSpokenAlarmTime = 0;
  let currentMilestoneIndex = -1;

  // 高德真实货车导航路线分段指引 (Turn-By-Turn Milestones)
  const amapMilestones = [
    {
      ratio: 0.0,
      road: '黄埔港起运中心 (开发大道)',
      action: '沿主路直行',
      dist: '800米',
      nextPreview: '随后 靠右驶入 广深沿江高速匝道',
      limit: 60,
      lanes: [false, true, true, false],
      iconSvg: '<path d="M24 8 L24 40 M24 8 L14 18 M24 8 L34 18" stroke="#38bdf8" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
      voiceText: '导航开始，前方直行进入开发大道，请保持合规行驶。'
    },
    {
      ratio: 0.12,
      road: '开发大道立交 ➔ 沿江高速匝道',
      action: '靠右侧驶入匝道',
      dist: '500米',
      nextPreview: '随后 汇入 广深沿江高速 (S33)',
      limit: 60,
      lanes: [false, false, false, true],
      iconSvg: '<path d="M16 38 L16 24 Q16 12 32 12 M32 12 L24 6 M32 12 L24 18" stroke="#38bdf8" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
      voiceText: '前方五百米，靠右驶入匝道，汇入广深沿江高速。'
    },
    {
      ratio: 0.25,
      road: '广深沿江高速 (麻涌特大桥)',
      action: '沿主线直行',
      dist: '18公里',
      nextPreview: '随后 经过 麻涌服务区与特大桥',
      limit: 80,
      lanes: [false, true, true, false],
      iconSvg: '<path d="M24 8 L24 40 M24 8 L14 18 M24 8 L34 18" stroke="#38bdf8" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
      voiceText: '前方经过麻涌特大桥，限速80公里，合规巡航中。'
    },
    {
      ratio: 0.45,
      road: '广深沿江高速 (洪梅枢纽)',
      action: '沿主干道直行',
      dist: '14公里',
      nextPreview: '随后 前往 沙田互通立交',
      limit: 80,
      lanes: [false, true, true, false],
      iconSvg: '<path d="M24 8 L24 40 M24 8 L14 18 M24 8 L34 18" stroke="#38bdf8" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
      voiceText: '前方直行经过洪梅立交，保持当前车道合规行驶。'
    },
    {
      ratio: 0.60,
      road: '广深沿江高速 (沙田立交)',
      action: '向右前方行驶',
      dist: '10公里',
      nextPreview: '随后 进入 虎门主线路段',
      limit: 80,
      lanes: [false, false, true, true],
      iconSvg: '<path d="M18 38 L18 26 Q18 16 30 14 M30 14 L24 9 M30 14 L26 19" stroke="#38bdf8" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
      voiceText: '前方沙田立交，向右前方行驶，进入虎门路段。'
    },
    {
      ratio: 0.75,
      road: '广深沿江高速 (虎门主线段)',
      action: '沿主线直行',
      dist: '16公里',
      nextPreview: '随后 经过 长安互通枢纽',
      limit: 80,
      lanes: [false, true, true, false],
      iconSvg: '<path d="M24 8 L24 40 M24 8 L14 18 M24 8 L34 18" stroke="#38bdf8" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
      voiceText: '沿广深沿江高速直行，经过虎门主线，走廊合规。'
    },
    {
      ratio: 0.90,
      road: '清溪支线 ➔ 智能产业园出口',
      action: '靠右减速出高速',
      dist: '800米',
      nextPreview: '随后 抵达 东莞清溪智能产业园',
      limit: 50,
      lanes: [false, false, false, true],
      iconSvg: '<path d="M16 38 L16 24 Q16 12 32 12 M32 12 L24 6 M32 12 L24 18" stroke="#38bdf8" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
      voiceText: '前方八百米即将出高速，请提前减速靠右行驶。'
    }
  ];

  // 7. 高德标准实时导航 UI 状态更新引擎
  function updateHud(speed, dist, roadName, isAlarm, mode, trafficInfo) {
    document.getElementById('hudSpeed').textContent = speed;
    document.getElementById('hudDevDist').textContent = dist;
    document.getElementById('hudRoad').textContent = roadName;

    // 1. 计算全行程进度与里程时间推算
    const totalLineCount = Math.max(1, window.routeEngine.highDenseLine.length - 1);
    const curIdx = simulator ? simulator.currentIndex : 0;
    const progressRatio = Math.min(1.0, Math.max(0.0, curIdx / totalLineCount));

    // 动态路况信息补齐 (若未传入，从当前索引自动匹配)
    if (!trafficInfo && window.routeEngine.getTrafficConditionAtIndex) {
      trafficInfo = window.routeEngine.getTrafficConditionAtIndex(curIdx);
    }

    const totalDistKm = (window.routeEngine.totalDistanceMeters || 101900) / 1000;
    const remainKm = Math.max(0.2, (totalDistKm * (1 - progressRatio))).toFixed(1);
    const totalMinutes = Math.round((window.routeEngine.durationSeconds || 6120) / 60);
    const remainMin = Math.max(1, Math.round(totalMinutes * (1 - progressRatio)));

    // 2. 刷新高德底部核心指标 (剩余里程、剩余时间、预计到达时刻)
    const amapRemainTimeEl = document.getElementById('amapRemainingTime');
    const amapRemainDistEl = document.getElementById('amapRemainingDist');
    const amapArrivalEl = document.getElementById('amapArrivalTime');
    const innavSpeed = document.getElementById('innavLiveSpeed');
    const innavDev = document.getElementById('innavDeviationDist');
    const speedStatusTag = document.getElementById('speedStatusTag');

    if (innavSpeed) innavSpeed.textContent = speed;
    if (amapRemainDistEl) amapRemainDistEl.textContent = remainKm;
    if (amapRemainTimeEl) {
      amapRemainTimeEl.textContent = remainMin >= 60 
        ? `${Math.floor(remainMin / 60)}小时${remainMin % 60}分` 
        : `${remainMin}分钟`;
    }
    if (amapArrivalEl) {
      const arrDate = new Date(Date.now() + remainMin * 60000);
      const hh = String(arrDate.getHours()).padStart(2, '0');
      const mm = String(arrDate.getMinutes()).padStart(2, '0');
      amapArrivalEl.textContent = `预计 ${hh}:${mm} 抵达`;
    }
    if (innavDev) {
      innavDev.textContent = `偏离 ${dist}m`;
      if (isAlarm) innavDev.className = 'sub-tag deviation alarm';
      else innavDev.className = 'sub-tag deviation';
    }

    // 3. 刷新右侧蚯蚓路况光柱光标 (Worm Bar - 从起点底部往终点顶部推进)
    const wormIndicator = document.getElementById('wormTruckIndicator');
    if (wormIndicator) {
      const bottomPercent = Math.min(95, Math.max(1, progressRatio * 96));
      wormIndicator.style.bottom = `${bottomPercent}%`;
      wormIndicator.style.top = 'auto';
    }

    // 3.1 刷新顶部真实路况提示徽章 (绿畅通/黄缓行/红拥堵)
    const innavTrafficPill = document.getElementById('innavTrafficPill');
    if (innavTrafficPill && trafficInfo) {
      const icon = trafficInfo.status === 'smooth' ? '🟢' : (trafficInfo.status === 'slow' ? '🟡' : '🔴');
      innavTrafficPill.textContent = `${icon} ${trafficInfo.label} · ${trafficInfo.hint || '合规通行'}`;
      innavTrafficPill.className = `amap-traffic-pill ${trafficInfo.status}`;
    }

    // 3.2 动态路况变化语音播报 (避免高频重复，路况等级跃迁时播报)
    if (trafficInfo && trafficInfo.status !== lastTrafficStatus) {
      lastTrafficStatus = trafficInfo.status;
      if (isDriverNavActive && !isAlarm) {
        if (trafficInfo.status === 'slow') {
          window.audioAlarm.speak(`前方即将进入${trafficInfo.label}，路况缓行，请保持车距减速慢行。`);
        } else if (trafficInfo.status === 'congested') {
          window.audioAlarm.speak(`前方道路车流密集，局部拥堵，请注意避让。`);
        } else if (trafficInfo.status === 'smooth') {
          window.audioAlarm.speak('前方路况恢复畅通，请合规巡航。');
        }
      }
    }

    // 4. 动态匹配高德 TBT 分段转向引导 (Milestone)
    let matchedMilestone = amapMilestones[0];
    let matchedIdx = 0;
    for (let i = 0; i < amapMilestones.length; i++) {
      if (progressRatio >= amapMilestones[i].ratio) {
        matchedMilestone = amapMilestones[i];
        matchedIdx = i;
      }
    }

    // 发生分段跃迁时触发语音提示
    if (matchedIdx !== currentMilestoneIndex) {
      currentMilestoneIndex = matchedIdx;
      if (isDriverNavActive && !isAlarm) {
        window.audioAlarm.speak(matchedMilestone.voiceText);
      }
    }

    // 5. 刷新顶部高德指引卡片
    const topCard = document.getElementById('driverInnavTop');
    const innavRoad = document.getElementById('innavRoadName');
    const nextPreview = document.getElementById('amapNextRoadPreview');
    const turnAction = document.getElementById('amapTurnAction');
    const turnDist = document.getElementById('amapTurnDist');
    const turnSvg = document.getElementById('turnSvgPath');
    const speedLimitVal = document.getElementById('speedLimitVal');
    const innavDot = document.getElementById('innavDot');
    const innavStatus = document.getElementById('innavStatusText');
    const laneContainer = document.getElementById('laneSlotsContainer');

    if (isAlarm) {
      // 🚨 偏航状态下高德深度警报视图
      if (topCard) topCard.classList.add('alarm');
      if (innavRoad) innavRoad.textContent = roadName || 'X241 县道 (未经审批的非标路线)';
      if (nextPreview) nextPreview.textContent = '已偏离审批货运走廊，请立即调头返回原规划路线！';
      if (turnAction) {
        turnAction.textContent = '立即调头返回';
        turnAction.style.color = '#f87171';
      }
      if (turnDist) turnDist.innerHTML = `${dist}<small>米</small>`;
      if (turnSvg) {
        turnSvg.innerHTML = '<path d="M34 38 L34 22 A12 12 0 0 0 10 22 L10 38 M10 38 L4 30 M10 38 L16 30" stroke="#ef4444" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>';
      }
      if (speedStatusTag) {
        speedStatusTag.className = 'speed-status alarm';
        speedStatusTag.textContent = '严重偏航';
      }
      if (innavDot && innavStatus) {
        innavDot.className = 'status-indicator-dot alarm';
        innavStatus.textContent = `偏航警报！已偏离 ${dist} 米 (超出走廊)`;
      }
      const lblQuick = document.getElementById('lblQuickDeviate');
      if (lblQuick) {
        lblQuick.textContent = '恢复合规';
        lblQuick.style.color = '#10b981';
      }
    } else {
      // 🛡️ 正常状态下高德标准指引视图
      if (topCard) topCard.classList.remove('alarm');
      if (innavRoad) innavRoad.textContent = matchedMilestone.road;
      if (nextPreview) nextPreview.textContent = matchedMilestone.nextPreview;
      if (turnAction) {
        turnAction.textContent = matchedMilestone.action;
        turnAction.style.color = '#38bdf8';
      }
      if (turnDist) turnDist.innerHTML = matchedMilestone.dist;
      if (turnSvg) turnSvg.innerHTML = matchedMilestone.iconSvg;
      if (speedLimitVal) speedLimitVal.textContent = matchedMilestone.limit;

      if (speedStatusTag) {
        if (speed > matchedMilestone.limit) {
          speedStatusTag.className = 'speed-status alarm';
          speedStatusTag.textContent = '超速预警';
        } else {
          speedStatusTag.className = 'speed-status safe';
          speedStatusTag.textContent = '合规巡航';
        }
      }

      if (innavDot && innavStatus) {
        innavDot.className = 'status-indicator-dot safe';
        innavStatus.textContent = `审批合规走廊行驶中 · 距中心线 ${dist} 米`;
      }

      // 车道推荐更新
      if (laneContainer && matchedMilestone.lanes) {
        const slots = laneContainer.querySelectorAll('.lane-slot');
        matchedMilestone.lanes.forEach((isActive, idx) => {
          if (slots[idx]) {
            slots[idx].className = isActive ? 'lane-slot active' : 'lane-slot muted';
          }
        });
      }

      const lblQuick = document.getElementById('lblQuickDeviate');
      if (lblQuick) {
        lblQuick.textContent = '偏航测试';
        lblQuick.style.color = '';
      }
    }

    const statusEl = document.getElementById('hudStatus');
    const markerEl = document.getElementById('truckMarkerIcon');

    if (isAlarm) {
      statusEl.textContent = '⚠️ 严重偏航';
      statusEl.className = 'metric-val status-text deviated';
      if (markerEl) markerEl.classList.add('deviated');
      if (actualTrackLayer) actualTrackLayer.setOptions({ strokeColor: '#ef4444' });
    } else if (mode === 'TUNNEL' && !window.offlineStorage.isOnline) {
      statusEl.textContent = '隧道弱网暂存';
      statusEl.className = 'metric-val status-text tunnel';
      if (markerEl) markerEl.classList.remove('deviated');
      if (actualTrackLayer) actualTrackLayer.setOptions({ strokeColor: '#f59e0b' });
    } else {
      statusEl.textContent = isRealGpsMode ? '真机在线通行' : '安全受控通行';
      statusEl.className = 'metric-val status-text normal';
      if (markerEl) markerEl.classList.remove('deviated');
      if (actualTrackLayer) actualTrackLayer.setOptions({ strokeColor: '#10b981' });
    }
  }

  // ============================================================
  // 偏航报警状态机：只在“进入偏航 / 恢复正常”两个跳变时触发一次性动作，
  // 偏航持续期间每 15 秒重复提醒一次，避免每个定位点都刷日志/重播语音
  // ============================================================
  let isDeviationActive = false;
  let deviationStartTime = 0;
  let lastAlarmReminderTime = 0;
  const ALARM_REMINDER_INTERVAL_MS = 15000;

  function vibrateDevice(pattern) {
    try {
      if (navigator.vibrate) navigator.vibrate(pattern);
    } catch (e) {}
  }

  function triggerDeviationAlarmUI(dist, roadName) {
    const now = Date.now();
    const banner = document.getElementById('alarmBanner');
    const overlay = document.getElementById('driverDeviationOverlay');
    const ddoDist = document.getElementById('ddoDist');

    // 持续刷新偏离距离 (每个定位点)
    if (banner) document.getElementById('alarmDist').textContent = dist;
    if (ddoDist) ddoDist.textContent = dist;

    if (!isDeviationActive) {
      // ---- 跳变：正常 -> 偏航 ----
      isDeviationActive = true;
      deviationStartTime = now;
      lastAlarmReminderTime = now;

      if (banner) banner.classList.add('active');
      if (overlay) {
        overlay.classList.remove('acked');
        overlay.classList.add('active');
      }

      window.audioAlarm.startDeviationAlarm();
      vibrateDevice([400, 200, 400, 200, 800]);
      window.audioAlarm.speak(`您已偏离规划路线 ${dist} 米，请尽快返回规划路线！`);

      appendLog('alarm', `【偏航预警】车辆脱离预定路线！垂线距离超标: ${dist}米 (${roadName})`);

      // 偏航事件单独上报，便于后端/调度端区分普通轨迹点
      const pos = currentAnimPos || lastRealCoord;
      if (pos) {
        window.offlineStorage.enqueue({
          eventType: 'DEVIATION_START',
          lng: pos[0], lat: pos[1],
          distanceMeters: dist,
          isDeviated: true,
          timestamp: now
        });
      }
      return;
    }

    // ---- 偏航持续中：定时重复提醒 ----
    if (now - lastAlarmReminderTime > ALARM_REMINDER_INTERVAL_MS) {
      lastAlarmReminderTime = now;
      window.audioAlarm.startDeviationAlarm();
      vibrateDevice([300, 150, 300]);
      window.audioAlarm.speak(`仍未返回规划路线，当前偏离 ${dist} 米`);
      // 司机已点“我知道了”时，距离继续扩大则重新弹出卡片
      if (overlay && overlay.classList.contains('acked') && dist > window.deviationDetector.thresholdMeters * 2) {
        overlay.classList.remove('acked');
      }
    }
  }

  function dismissDeviationAlarmUI() {
    const banner = document.getElementById('alarmBanner');
    const overlay = document.getElementById('driverDeviationOverlay');
    if (banner) banner.classList.remove('active');
    if (overlay) overlay.classList.remove('active', 'acked');
    window.audioAlarm.stopAlarm();

    if (isDeviationActive) {
      // ---- 跳变：偏航 -> 恢复正常 ----
      isDeviationActive = false;
      const durSec = Math.round((Date.now() - deviationStartTime) / 1000);
      if (isDriverNavActive) window.audioAlarm.speak('已回到规划路线，请继续按导航行驶');
      appendLog('success', `【偏航解除】车辆已回到规划走廊内 (本次偏航持续 ${durSec} 秒)`);

      const pos = currentAnimPos || lastRealCoord;
      if (pos) {
        window.offlineStorage.enqueue({
          eventType: 'DEVIATION_END',
          lng: pos[0], lat: pos[1],
          isDeviated: false,
          deviationDurationSec: durSec,
          timestamp: Date.now()
        });
      }
    }
  }

  // 司机确认知晓：收起中间卡片，保留红色边框直到回到路线，并暂停本轮蜂鸣
  const btnDdoAck = document.getElementById('btnDdoAck');
  if (btnDdoAck) {
    btnDdoAck.addEventListener('click', () => {
      const overlay = document.getElementById('driverDeviationOverlay');
      if (overlay) overlay.classList.add('acked');
      window.audioAlarm.stopAlarm();
      lastAlarmReminderTime = Date.now();
    });
  }

  function appendLog(level, msg) {
    const list = document.getElementById('logsList');
    if (!list) return;
    const time = new Date().toLocaleTimeString();
    const item = document.createElement('div');
    item.className = `log-item ${level}`;
    item.innerHTML = `<span class="time">[${time}]</span><span class="msg">${msg}</span>`;
    list.prepend(item);

    // 保持最多 60 条日志
    if (list.children.length > 60) {
      list.removeChild(list.lastChild);
    }
  }

  // 8. 离线缓存队列与云端实时上传回调
  window.offlineStorage.onQueueChange = (pendingCount, uploadedCount, flushedBatch) => {
    document.getElementById('offlineQueueCount').textContent = `${pendingCount} 条`;
    document.getElementById('uploadedCount').textContent = `${uploadedCount} 次`;

    const netDot = document.getElementById('netStatusDot');
    const netTxt = document.getElementById('netStatusText');

    if (!window.offlineStorage.isOnline) {
      netDot.className = 'status-indicator offline';
      netTxt.textContent = '网络离线 (暂存中)';
    } else {
      netDot.className = 'status-indicator online';
      netTxt.textContent = '网络正常';
    }

    if (flushedBatch && flushedBatch.length > 0) {
      appendLog('success', `【网络恢复】触发断点补传，批量补齐 ${flushedBatch.length} 条离线轨迹点！`);
    }
  };

  // 监听浏览器/手机网络在线与断网状态变化
  window.addEventListener('online', () => {
    appendLog('info', '【移动网络】检测到网络恢复连接，自动尝试同步离线轨迹数据...');
    window.offlineStorage.setNetworkStatus(true);
  });
  window.addEventListener('offline', () => {
    appendLog('warn', '【移动网络】网络已中断，系统已自动切换至本地离线暂存模式！');
    window.offlineStorage.setNetworkStatus(false);
  });

  // 云端实时抓包上传成功回调
  window.offlineStorage.onUploadSuccess = (info) => {
    const lastUploadTag = document.getElementById('lastUploadTag');
    const uploadPacketJson = document.getElementById('uploadPacketJson');
    const packetStatus = document.getElementById('packetStatus');

    if (lastUploadTag) lastUploadTag.textContent = `${info.time} (已上报 ${info.batchCount} 条)`;
    if (packetStatus) packetStatus.textContent = `HTTP 200 OK (${info.time})`;

    if (uploadPacketJson && info.latest) {
      const previewObj = {
        truckPlate: '粤B·8890A',
        lat: info.latest.data.lat,
        lng: info.latest.data.lng,
        speed_kmh: info.latest.data.speed,
        deviation_m: info.latest.data.distanceMeters,
        accuracy_m: info.latest.data.accuracy || 15,
        timestamp: info.latest.createTime,
        status: 'DELIVERED_TO_CLOUD'
      };
      uploadPacketJson.textContent = JSON.stringify(previewObj, null, 2);
    }
  };

  // 业务后端接收接口 URL 输入响应
  const uploadApiUrlInput = document.getElementById('uploadApiUrlInput');
  if (uploadApiUrlInput) {
    uploadApiUrlInput.addEventListener('input', (e) => {
      const url = e.target.value.trim();
      window.offlineStorage.uploadApiUrl = url;
      appendLog('info', url ? `【云端配置】已配置真实后端上报地址: ${url}` : '【云端配置】已切换为前端离线暂存模拟模式');
    });
  }

  // 9. 交互事件监听与操作响应

  // 手机真机 GPS 开关
  document.getElementById('btnRealGpsToggle').addEventListener('click', () => {
    if (isRealGpsMode) {
      stopRealGpsMode();
    } else {
      startRealGpsMode();
    }
  });

  // 移动端底栏快捷按钮联动
  const mobileToggleBtn = document.getElementById('btnMobileToggleGps');
  if (mobileToggleBtn) {
    mobileToggleBtn.addEventListener('click', () => {
      if (isRealGpsMode) {
        stopRealGpsMode();
      } else {
        startRealGpsMode();
      }
    });
  }

  // 以当前手机定位为起点生成走廊
  function planFromCurrentGps() {
    if (lastRealCoord) {
      const [lng, lat] = lastRealCoord;
      window.routeEngine.generateRouteFromCurrentPosition(lng, lat, 2.5);
      drawBaseRouteAndCorridor();
      actualTrackPoints.length = 0;
      actualTrackLayer.setLatLngs([]);
      truckMarker.setLatLng([lat, lng]);
      map.setView([lat, lng], 16);
      appendLog('success', `已成功以手机当前位置 [${lng.toFixed(4)}, ${lat.toFixed(4)}] 生成 2.5km 测试走廊！`);
    } else {
      // 临时单次获取当前位置
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const lat = pos.coords.latitude;
          const lng = pos.coords.longitude;
          lastRealCoord = [lng, lat];
          window.routeEngine.generateRouteFromCurrentPosition(lng, lat, 2.5);
          drawBaseRouteAndCorridor();
          truckMarker.setLatLng([lat, lng]);
          map.setView([lat, lng], 16);
          appendLog('success', `已获取当前位置 [${lng.toFixed(4)}, ${lat.toFixed(4)}] 并生成测试走廊！`);
        },
        (err) => {
          handleRealGpsError(err);
        },
        { enableHighAccuracy: true, timeout: 8000 }
      );
    }
  }

  document.getElementById('btnPlanFromCurrentGps').addEventListener('click', planFromCurrentGps);
  const mobilePlanBtn = document.getElementById('btnMobilePlanHere');
  if (mobilePlanBtn) mobilePlanBtn.addEventListener('click', planFromCurrentGps);

  // 居中查看我的位置
  function centerToGps() {
    if (lastRealCoord) {
      map.setView([lastRealCoord[1], lastRealCoord[0]], 16);
    } else {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const lat = pos.coords.latitude;
          const lng = pos.coords.longitude;
          lastRealCoord = [lng, lat];
          map.setView([lat, lng], 16);
        },
        (err) => handleRealGpsError(err)
      );
    }
  }
  document.getElementById('btnCenterGps').addEventListener('click', centerToGps);
  const mobileCenterBtn = document.getElementById('btnMobileCenter');
  if (mobileCenterBtn) mobileCenterBtn.addEventListener('click', centerToGps);

  // 恢复广深演示路线
  document.getElementById('btnResetDemoRoute').addEventListener('click', () => {
    window.routeEngine.resetToDefaultDemoRoute();
    drawBaseRouteAndCorridor();
    actualTrackPoints.length = 0;
    actualTrackLayer.setLatLngs([]);
    const startCoord = window.routeEngine.highDenseLine[0];
    truckMarker.setLatLng([startCoord[1], startCoord[0]]);
    appendLog('info', '已重置为默认广州黄埔港至东莞清溪演示路线。');
  });

  // 自动跟随开关
  document.getElementById('chkAutoFollow').addEventListener('change', (e) => {
    autoFollow = e.target.checked;
    appendLog('info', `自动视口跟随已切换为: ${autoFollow ? '开启' : '关闭'}`);
  });

  // 偏航阈值滑动条
  const thresholdRange = document.getElementById('thresholdRange');
  thresholdRange.addEventListener('input', (e) => {
    const val = Number(e.target.value);
    document.getElementById('thresholdVal').textContent = `${val} 米`;
    window.deviationDetector.setThreshold(val);
    drawBaseRouteAndCorridor();
  });

  // 偏航阈值快捷芯片
  document.querySelectorAll('.btn-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = Number(btn.getAttribute('data-val'));
      thresholdRange.value = val;
      document.getElementById('thresholdVal').textContent = `${val} 米`;
      window.deviationDetector.setThreshold(val);
      drawBaseRouteAndCorridor();
      document.querySelectorAll('.btn-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      appendLog('info', `偏航容差阈值已设为: ${val} 米`);
    });
  });

  // 统一高德在线规划执行函数
  async function executeAmapRoutePlanning() {
    const startInput = document.getElementById('startPointInput');
    const endInput = document.getElementById('endPointInput');
    const keyInput = document.getElementById('amapKeyInput');
    const btnAmap = document.getElementById('btnCallAmapApi');

    const startVal = (startInput.value || '').trim() || '广州黄埔港物流中心';
    const endVal = (endInput.value || '').trim() || '东莞清溪智能产业园';
    const keyVal = (keyInput.value || '').trim() || '1b5afcd4182988278fda8e81237b07d9';

    const originParam = (startVal.includes('当前位置') || startVal.includes('我的位置')) && lastRealCoord
      ? lastRealCoord
      : startVal;
    const destParam = endVal;

    if (btnAmap) {
      btnAmap.disabled = true;
      btnAmap.innerHTML = '<span class="btn-icon">⏳</span> 正在向高德云端规划路线...';
    }

    appendLog('info', `【高德 API】正在发起路径规划: 从 [${startVal}] 到 [${endVal}] (车型: 13.5m重卡/4轴/36吨/限高4m)...`);

    try {
      const res = await window.routeEngine.planWithAmapWebApi(
        originParam,
        destParam,
        { height: 4.0, width: 2.55, weight: 36.0, axis: 4, size: 4 },
        keyVal
      );

      // 重新绘制底图高亮蓝色规划线与 250m 安全管道缓冲区
      drawBaseRouteAndCorridor();

      // 同步更新司机确认卡片与各 HUD 里程时间文本
      syncRouteInfoToUI();

      // 复位小车到新路线的起点
      const newStart = window.routeEngine.highDenseLine[0];
      truckMarker.setPosition(newStart);
      currentAnimPos = [...newStart];
      currentAnimHeading = 0;
      actualTrackPoints.length = 0;
      actualTrackLayer.setPath([]);
      dismissDeviationAlarmUI();
      if (simulator) simulator.reset();

      // 自动将视角对准新规划路线
      if (plannedPolylineLayer) {
        map.setFitView([plannedPolylineLayer], false, [60, 60, 60, 60]);
      }

      closeRouteSwitchModal();
      renderRouteCandidateChips();
      appendLog('success', `【高德在线算路成功】使用引擎: ${res.engine} | 全线里程: ${(res.distanceMeters / 1000).toFixed(1)}公里 | 预估耗时: ${Math.round(res.durationSeconds / 60)}分钟 | 高精道路节点: ${res.pointsCount}个！`);
      window.audioAlarm.speak(`路线规划成功，全长 ${(res.distanceMeters / 1000).toFixed(1)} 公里，已为您锁定合规货运通道！`);
    } catch (err) {
      appendLog('alarm', `【高德 API 失败】${err.message}`);
      alert(`高德路径规划提示:\n${err.message}\n\n已为您自动保留高德当前基准路线。您也可以点击输入框上方的“📍 地图选点”直接在地图上点击任意两点规划路线！`);
    } finally {
      if (btnAmap) {
        btnAmap.disabled = false;
        btnAmap.innerHTML = '<span class="btn-icon">📡</span> 调取高德官方 API 实时算路并绘制走廊';
      }
    }
  }

  // 同步路线元数据至前端各卡片与指示条
  function syncRouteInfoToUI() {
    const startName = window.routeEngine.startName || '广州黄埔港物流中心';
    const endName = window.routeEngine.endName || '东莞清溪智能产业园';
    const distKm = ((window.routeEngine.totalDistanceMeters || 101900) / 1000).toFixed(1);
    const durMin = Math.round((window.routeEngine.durationSeconds || 6120) / 60);

    const cStart = document.getElementById('confirmStartPoint');
    const cEnd = document.getElementById('confirmEndPoint');
    const cDist = document.getElementById('confirmRouteDist');
    const cDur = document.getElementById('confirmDuration');
    const remDist = document.getElementById('amapRemainingDist');
    const remTime = document.getElementById('amapRemainingTime');
    const wormStart = document.querySelector('.worm-start-tag');
    const wormEnd = document.querySelector('.worm-end-tag');

    if (cStart) cStart.textContent = startName;
    if (cEnd) cEnd.textContent = endName;
    if (cDist) cDist.textContent = `${distKm} km`;
    if (cDur) cDur.textContent = `${durMin}`;
    if (remDist) remDist.textContent = distKm;
    if (remTime) remTime.textContent = durMin >= 60 ? `${Math.floor(durMin / 60)}小时${durMin % 60}分` : `${durMin}分钟`;
    if (wormStart) wormStart.textContent = window.routeEngine.startShort || startName.slice(0, 2);
    if (wormEnd) wormEnd.textContent = window.routeEngine.endShort || endName.slice(0, 2);
  }

  // 一键应用精品预设路线 (0毫秒即时切换)
  function applyPresetRoute(presetId) {
    if (!window.routeEngine.loadPresetRoute(presetId)) return;

    // 1. 重新绘制高德路况底图与走廊
    drawBaseRouteAndCorridor();

    // 2. 同步刷新所有 UI
    syncRouteInfoToUI();

    // 3. 复位车辆
    const newStart = window.routeEngine.highDenseLine[0];
    truckMarker.setPosition(newStart);
    currentAnimPos = [...newStart];
    currentAnimHeading = 0;
    actualTrackPoints.length = 0;
    actualTrackLayer.setPath([]);
    dismissDeviationAlarmUI();
    if (simulator) simulator.reset();

    // 4. 全景适配
    if (plannedPolylineLayer) {
      map.setFitView([plannedPolylineLayer], false, [60, 60, 60, 60]);
    }

    // 5. 更新弹窗内激活项高亮
    document.querySelectorAll('.preset-route-item').forEach(el => {
      const isCur = el.getAttribute('data-route-id') === presetId;
      el.classList.toggle('active', isCur);
      const btn = el.querySelector('.btn-apply-preset');
      if (btn && el.getAttribute('data-route-id')) {
        btn.textContent = isCur ? '当前路线' : '切换到此线';
      }
    });

    // 6. 同步刷新同城市对的多条备选方案 Chips
    renderRouteCandidateChips();

    closeRouteSwitchModal();
    appendLog('success', `【路线已切换】已成功载入【${window.routeEngine.startName} ➔ ${window.routeEngine.endName}】(全程 ${(window.routeEngine.totalDistanceMeters / 1000).toFixed(1)}公里)！`);
    window.audioAlarm.speak(`货运路线已更新为：${window.routeEngine.startName}至${window.routeEngine.endName}，全线已锁定合规走廊。`);
  }

  // 路线切换全功能弹窗逻辑
  const routeSwitchModal = document.getElementById('routeSwitchModal');
  const routeModalBackdrop = document.getElementById('routeModalBackdrop');
  const btnCloseRouteModal = document.getElementById('btnCloseRouteModal');
  const btnOpenRouteSwitchModal = document.getElementById('btnOpenRouteSwitchModal');
  const confirmOdClickArea = document.getElementById('confirmOdClickArea');
  const tabPresetRoutes = document.getElementById('tabPresetRoutes');
  const tabCustomRoute = document.getElementById('tabCustomRoute');
  const contentPresetRoutes = document.getElementById('contentPresetRoutes');
  const contentCustomRoute = document.getElementById('contentCustomRoute');

  function openRouteSwitchModal() {
    if (routeSwitchModal) routeSwitchModal.style.display = 'flex';
    // 更新手机定位点文本
    const gpsTxt = document.getElementById('modalGpsStartText');
    if (gpsTxt && lastRealCoord) {
      gpsTxt.textContent = `手机当前定位点 (${lastRealCoord[0].toFixed(3)}, ${lastRealCoord[1].toFixed(3)})`;
    }
  }

  function closeRouteSwitchModal() {
    if (routeSwitchModal) routeSwitchModal.style.display = 'none';
  }

  if (btnOpenRouteSwitchModal) btnOpenRouteSwitchModal.addEventListener('click', openRouteSwitchModal);
  if (confirmOdClickArea) confirmOdClickArea.addEventListener('click', openRouteSwitchModal);
  if (btnCloseRouteModal) btnCloseRouteModal.addEventListener('click', closeRouteSwitchModal);
  if (routeModalBackdrop) routeModalBackdrop.addEventListener('click', closeRouteSwitchModal);

  // Tab 切换
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
      if (contentCustomRoute) contentCustomRoute.style.display = 'block';
      if (contentPresetRoutes) contentPresetRoutes.style.display = 'none';
    });
  }

  // 绑定预设路线项点击
  document.querySelectorAll('.preset-route-item').forEach(item => {
    const routeId = item.getAttribute('data-route-id');
    if (routeId) {
      item.addEventListener('click', () => {
        applyPresetRoute(routeId);
      });
    }
  });

  // 动态渲染当前起终点 (A ➔ B) 下的多条候选路线方案 Chips (高德经典多方案选路)
  function renderRouteCandidateChips() {
    const container = document.getElementById('routeChoiceChipsBar');
    if (!container) return;

    const candidates = window.routeEngine.candidateRoutes || [];
    const activeIdx = window.routeEngine.activeCandidateIndex || 0;

    container.innerHTML = '';

    const titleEl = document.createElement('span');
    titleEl.className = 'choice-title';
    titleEl.textContent = `方案备选 (${candidates.length}条):`;
    container.appendChild(titleEl);

    candidates.forEach((route, idx) => {
      const btn = document.createElement('button');
      btn.className = `route-chip-btn ${idx === activeIdx ? 'active' : ''}`;
      btn.setAttribute('data-candidate-index', idx);
      btn.title = route.desc || route.name;

      const durMin = Math.round(route.durationSeconds / 60);
      const durText = durMin >= 60 ? `${Math.floor(durMin / 60)}时${durMin % 60}分` : `${durMin}分`;
      const tollText = route.tolls && route.tolls !== '0' ? `·￥${route.tolls}` : '·免过路费';
      const kmText = `${(route.distanceMeters / 1000).toFixed(1)}km`;

      const tagClass = idx === 0 ? 'chip-tag best' : 'chip-tag';
      const tagText = route.tag || `方案${idx + 1}`;

      btn.innerHTML = `
        <span class="${tagClass}">${tagText}</span>
        <span class="chip-name">${route.via || route.name} (${kmText}·${durText}${tollText})</span>
      `;

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        applyCandidateRoute(idx);
      });

      container.appendChild(btn);
    });

    // 换城市 / 更多起终点按钮
    const moreBtn = document.createElement('button');
    moreBtn.className = 'route-chip-btn more-btn';
    moreBtn.id = 'btnChipOpenMore';
    moreBtn.title = '打开弹窗切换起终点城市或自定义算路';
    moreBtn.innerHTML = '<span>换城市 ❯</span>';
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openRouteSwitchModal();
    });
    container.appendChild(moreBtn);
  }

  // 选定其中一条路线方案并立即更新导航底图与安全走廊
  function applyCandidateRoute(index) {
    if (!window.routeEngine.selectCandidateRoute(index)) return;

    // 1. 重新绘制高德路况底图与 250m 安全管道走廊
    drawBaseRouteAndCorridor();

    // 2. 同步刷新所有 UI (里程、耗时、过路费、途径点)
    syncRouteInfoToUI();

    // 3. 复位车辆到新方案起点
    const newStart = window.routeEngine.highDenseLine[0];
    truckMarker.setPosition(newStart);
    currentAnimPos = [...newStart];
    currentAnimHeading = 0;
    actualTrackPoints.length = 0;
    actualTrackLayer.setPath([]);
    dismissDeviationAlarmUI();
    if (simulator) simulator.reset();

    // 4. 全景适配新方案视野
    if (plannedPolylineLayer) {
      map.setFitView([plannedPolylineLayer], false, [60, 60, 60, 60]);
    }

    // 5. 重新渲染 Chips 激活态
    renderRouteCandidateChips();

    const cur = window.routeEngine.candidateRoutes[index];
    appendLog('info', `【路线方案已选定】已切换为【${cur.name}】(${cur.via}) | 全长 ${(cur.distanceMeters / 1000).toFixed(1)}km | 预估 ${Math.round(cur.durationSeconds / 60)}分钟 | 过路费: ￥${cur.tolls}`);
    window.audioAlarm.speak(`已为您选定${cur.name}，全程 ${(cur.distanceMeters / 1000).toFixed(1)} 公里，走廊已重新绘制。`);
  }

  // 手机 GPS 路线测试点击
  const btnModalApplyGps = document.getElementById('btnModalApplyGps');
  if (btnModalApplyGps) {
    btnModalApplyGps.addEventListener('click', (e) => {
      e.stopPropagation();
      closeRouteSwitchModal();
      planFromCurrentGps();
    });
  }

  // 自定义算路提交
  const btnModalSubmitRoute = document.getElementById('btnModalSubmitRoute');
  if (btnModalSubmitRoute) {
    btnModalSubmitRoute.addEventListener('click', async () => {
      const s = document.getElementById('modalStartInput')?.value?.trim() || '广州黄埔港物流中心';
      const d = document.getElementById('modalEndInput')?.value?.trim() || '东莞清溪智能产业园';
      document.getElementById('startPointInput').value = s;
      document.getElementById('endPointInput').value = d;
      
      const origHtml = btnModalSubmitRoute.innerHTML;
      btnModalSubmitRoute.disabled = true;
      btnModalSubmitRoute.innerHTML = '<span class="btn-icon">⏳</span> <span>正在向高德云端规划路线并绘制走廊...</span>';
      try {
        await executeAmapRoutePlanning();
      } finally {
        btnModalSubmitRoute.disabled = false;
        btnModalSubmitRoute.innerHTML = origHtml;
      }
    });
  }

  // 弹窗内的地图选点
  const btnModalPickStart = document.getElementById('btnModalPickStart');
  if (btnModalPickStart) {
    btnModalPickStart.addEventListener('click', (e) => {
      e.stopPropagation();
      closeRouteSwitchModal();
      const btn = document.getElementById('btnPickStartOnMap');
      if (btn) btn.click();
    });
  }
  const btnModalPickEnd = document.getElementById('btnModalPickEnd');
  if (btnModalPickEnd) {
    btnModalPickEnd.addEventListener('click', (e) => {
      e.stopPropagation();
      closeRouteSwitchModal();
      const btn = document.getElementById('btnPickEndOnMap');
      if (btn) btn.click();
    });
  }

  // 调取高德官方 API 按钮绑定
  const btnCallAmapApi = document.getElementById('btnCallAmapApi');
  if (btnCallAmapApi) {
    btnCallAmapApi.addEventListener('click', executeAmapRoutePlanning);
  }

  // 绑定回车键一键触发路线计算
  ['startPointInput', 'endPointInput', 'amapKeyInput'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          executeAmapRoutePlanning();
        }
      });
    }
  });

  // 地图点选设置起终点功能
  let mapPickingTarget = null; // 'START' | 'END' | null

  const btnPickStart = document.getElementById('btnPickStartOnMap');
  if (btnPickStart) {
    btnPickStart.addEventListener('click', (e) => {
      e.stopPropagation();
      mapPickingTarget = 'START';
      map.getContainer().style.cursor = 'crosshair';
      appendLog('info', '【地图选点模式】请直接在地图上任意点击一个位置，将其设为起点坐标！');
      closeMobileSidebar();
    });
  }

  const btnPickEnd = document.getElementById('btnPickEndOnMap');
  if (btnPickEnd) {
    btnPickEnd.addEventListener('click', (e) => {
      e.stopPropagation();
      mapPickingTarget = 'END';
      map.getContainer().style.cursor = 'crosshair';
      appendLog('info', '【地图选点模式】请直接在地图上任意点击一个位置，将其设为终点坐标！');
      closeMobileSidebar();
    });
  }

  // 监听地图点击
  map.on('click', (e) => {
    if (mapPickingTarget === 'START') {
      const lng = Number(e.lnglat.lng.toFixed(6));
      const lat = Number(e.lnglat.lat.toFixed(6));
      document.getElementById('startPointInput').value = `${lng}, ${lat}`;
      const mStart = document.getElementById('modalStartInput');
      if (mStart) mStart.value = `${lng}, ${lat}`;
      mapPickingTarget = null;
      map.getContainer().style.cursor = '';
      appendLog('success', `【已选定起点】[${lng}, ${lat}]，正在自动调取高德计算最新规划路线...`);
      executeAmapRoutePlanning();
    } else if (mapPickingTarget === 'END') {
      const lng = Number(e.lnglat.lng.toFixed(6));
      const lat = Number(e.lnglat.lat.toFixed(6));
      document.getElementById('endPointInput').value = `${lng}, ${lat}`;
      const mEnd = document.getElementById('modalEndInput');
      if (mEnd) mEnd.value = `${lng}, ${lat}`;
      mapPickingTarget = null;
      map.getContainer().style.cursor = '';
      appendLog('success', `【已选定终点】[${lng}, ${lat}]，正在自动调取高德计算最新规划路线...`);
      executeAmapRoutePlanning();
    }
  });

  // 快捷预设路线按钮
  const btnSample1 = document.getElementById('btnSample1');
  if (btnSample1) {
    btnSample1.addEventListener('click', () => {
      applyPresetRoute('airport_line');
    });
  }

  const btnSample2 = document.getElementById('btnSample2');
  if (btnSample2) {
    btnSample2.addEventListener('click', () => {
      applyPresetRoute('yantian_fenggang');
    });
  }

  const btnSample3 = document.getElementById('btnSample3');
  if (btnSample3) {
    btnSample3.addEventListener('click', () => {
      applyPresetRoute('guangzhou_dongguan');
    });
  }

  // 恢复默认广深路线
  const btnResetRoute = document.getElementById('btnResetToDefaultRoute') || document.getElementById('btnPlanRoute');
  if (btnResetRoute) {
    btnResetRoute.addEventListener('click', () => {
      applyPresetRoute('guangzhou_dongguan');
      appendLog('info', '已恢复默认广州黄埔港至东莞清溪演示基线。');
    });
  }

  // 唤起司机端高德地图 App 导航 (带强制途经点)
  const btnLaunchAmapApp = document.getElementById('btnLaunchAmapApp');
  if (btnLaunchAmapApp) {
    btnLaunchAmapApp.addEventListener('click', () => {
      const start = lastRealCoord || window.routeEngine.baseCoordinates[0];
      const end = window.routeEngine.baseCoordinates[window.routeEngine.baseCoordinates.length - 1];
      const via = [
        { lng: 113.5854, lat: 23.0018, name: '麻涌特大桥必经卡口' },
        { lng: 113.7850, lat: 22.8520, name: '虎门互通枢纽' }
      ];

      const schemeUrl = window.routeEngine.getAmapAppLaunchUrl(
        start,
        end,
        window.routeEngine.startName,
        window.routeEngine.endName,
        via
      );

      appendLog('info', `【唤起高德地图】正在向系统发起 URL Scheme: ${schemeUrl.substring(0, 60)}...`);
      
      // 尝试在手机上唤起 App
      window.location.href = schemeUrl;

      setTimeout(() => {
        appendLog('info', '若手机未安装高德地图 App，可通过浏览器直接打开高德 H5 导航页面。');
      }, 1500);
    });
  }

  // 仿真控制器按钮
  document.getElementById('btnDriveNormal').addEventListener('click', () => {
    if (isRealGpsMode) stopRealGpsMode();
    simulator.startNormal();
    appendLog('info', '【仿真开始】模拟货车正常行驶。');
  });

  document.getElementById('btnDriveDeviate').addEventListener('click', () => {
    if (isRealGpsMode) stopRealGpsMode();
    simulator.startDeviate();
    appendLog('warn', '【仿真开始】模拟货车下道偏航，准备触发报警...');
  });

  document.getElementById('btnSimTunnel').addEventListener('click', () => {
    if (isRealGpsMode) stopRealGpsMode();
    simulator.startTunnelOffline();
    appendLog('warn', '【仿真开始】模拟进隧道断网，进入本地暂存模式...');
  });

  document.getElementById('btnResetSim').addEventListener('click', () => {
    if (isRealGpsMode) stopRealGpsMode();
    simulator.reset();
    actualTrackPoints.length = 0;
    actualTrackLayer.setLatLngs([]);
    dismissDeviationAlarmUI();
    const startCoord = window.routeEngine.highDenseLine[0];
    truckMarker.setLatLng([startCoord[1], startCoord[0]]);
    updateHud(0, 0, '就绪待命', false, 'IDLE');
    appendLog('info', '车辆复位完成。');
  });

  // 移动端控制面板抽屉开关
  const controlPanel = document.getElementById('controlPanel');
  const sidebarBackdrop = document.getElementById('sidebarBackdrop');

  function openMobileSidebar() {
    controlPanel.classList.add('mobile-open');
    sidebarBackdrop.classList.add('active');
  }

  function closeMobileSidebar() {
    controlPanel.classList.remove('mobile-open');
    sidebarBackdrop.classList.remove('active');
  }

  document.getElementById('btnToggleSidebar').addEventListener('click', openMobileSidebar);
  document.getElementById('btnCloseSidebar').addEventListener('click', closeMobileSidebar);
  sidebarBackdrop.addEventListener('click', closeMobileSidebar);

  const mobileOpenMenuBtn = document.getElementById('btnMobileOpenMenu');
  if (mobileOpenMenuBtn) mobileOpenMenuBtn.addEventListener('click', openMobileSidebar);

  // 日志面板折叠/清空
  const eventLogsPanel = document.getElementById('eventLogsPanel');
  const btnToggleLogsFold = document.getElementById('btnToggleLogsFold');
  if (btnToggleLogsFold) {
    btnToggleLogsFold.addEventListener('click', () => {
      const isFolded = eventLogsPanel.classList.toggle('folded');
      btnToggleLogsFold.textContent = isFolded ? '展开' : '收起';
    });
  }

  document.getElementById('btnClearLogs').addEventListener('click', () => {
    document.getElementById('logsList').innerHTML = '';
  });

  document.getElementById('btnCallDriver').addEventListener('click', () => {
    alert('正在发起 VoIP 调度外呼，直连司机车载端电话：138-0000-8890...');
  });

  document.getElementById('btnCloseGeoTip').addEventListener('click', () => {
    document.getElementById('geoTipModal').style.display = 'none';
  });

  // ============================================================
  // 10. 全新：司机端真实导航工作流 & 手机尺寸视图控制
  // ============================================================
  wakeLockSentinel = null;

  const btnModeDriver = document.getElementById('btnModeDriver');
  const btnModeDispatch = document.getElementById('btnModeDispatch');
  const btnFrameSim = document.getElementById('btnFrameSim');
  const btnFrameFull = document.getElementById('btnFrameFull');

  const driverRouteConfirmCard = document.getElementById('driverRouteConfirmCard');
  const driverInnavTop = document.getElementById('driverInnavTop');
  const driverInnavBottom = document.getElementById('driverInnavBottom');
  const btnConfirmStartNav = document.getElementById('btnConfirmStartNav');
  const btnInnavStopNav = document.getElementById('btnInnavStopNav');
  const btnInnavRecenter = document.getElementById('btnInnavRecenter');
  const btnInnavToggleAudio = document.getElementById('btnInnavToggleAudio');
  const btnDriverWakeAmapApp = document.getElementById('btnDriverWakeAmapApp');

  // 视图模式切换
  function setViewMode(mode) {
    if (mode === 'DRIVER') {
      document.body.classList.add('mode-driver');
      document.body.classList.add('desktop-phone-sim-active');
      if (btnModeDriver) btnModeDriver.classList.add('active');
      if (btnModeDispatch) btnModeDispatch.classList.remove('active');
      if (btnFrameSim) btnFrameSim.classList.add('active');
      if (btnFrameFull) btnFrameFull.classList.remove('active');
    } else {
      document.body.classList.remove('mode-driver');
      document.body.classList.remove('desktop-phone-sim-active');
      if (btnModeDispatch) btnModeDispatch.classList.add('active');
      if (btnModeDriver) btnModeDriver.classList.remove('active');
    }
    setTimeout(() => {
      if (map.resize) map.resize();
      if (!isDriverNavActive && plannedPolylineLayer) {
        if (mode === 'DRIVER') {
          map.setFitView([plannedPolylineLayer], false, [60, 35, 260, 35]);
        } else {
          map.setFitView([plannedPolylineLayer], false, [50, 50, 50, 50]);
        }
      }
    }, 200);
  }

  if (btnModeDriver) btnModeDriver.addEventListener('click', () => setViewMode('DRIVER'));
  if (btnModeDispatch) btnModeDispatch.addEventListener('click', () => setViewMode('DISPATCH'));

  // 手机模拟框尺寸切换
  if (btnFrameSim) {
    btnFrameSim.addEventListener('click', () => {
      document.body.classList.add('desktop-phone-sim-active');
      btnFrameSim.classList.add('active');
      if (btnFrameFull) btnFrameFull.classList.remove('active');
      setTimeout(() => { if (map.resize) map.resize(); }, 200);
    });
  }

  if (btnFrameFull) {
    btnFrameFull.addEventListener('click', () => {
      document.body.classList.remove('desktop-phone-sim-active');
      btnFrameFull.classList.add('active');
      if (btnFrameSim) btnFrameSim.classList.remove('active');
      setTimeout(() => { if (map.resize) map.resize(); }, 200);
    });
  }

  // 🚀 核心：司机点击【确认导航路线 · 开始实时导航】
  async function startDriverLiveNavigation() {
    isDriverNavActive = true;
    autoFollow = true;

    // 1. 初始化航向：提取规划路线第 0 点到第 1 点的朝向，让车头精准指向前方道路！
    const line = window.routeEngine.highDenseLine;
    if (line.length >= 2) {
      const b = turf.bearing(turf.point(line[0]), turf.point(line[1]));
      currentVehicleHeading = (b + 360) % 360;
    }

    // 2. 语音播报：高德货车合规路线锁定
    window.audioAlarm.speak('导航开始，已锁定合规货运路线，请按规划路线向前行驶！');

    // 3. 尝试唤醒屏幕防休眠 (WakeLock API)
    try {
      if ('wakeLock' in navigator) {
        wakeLockSentinel = await navigator.wakeLock.request('screen');
      }
    } catch (e) {}

    // 4. 隐藏路线确认卡片，展示高德专业导航驾驶 HUD 与右侧蚯蚓条
    const rightDock = document.getElementById('amapRightDock');
    if (driverRouteConfirmCard) driverRouteConfirmCard.style.display = 'none';
    if (driverInnavTop) driverInnavTop.style.display = 'flex';
    if (driverInnavBottom) driverInnavBottom.style.display = 'flex';
    if (rightDock) rightDock.style.display = 'flex';

    // 5. 立即开启高德 3D 车头朝上立体模式 (下沉居中视角，清晰展现前方具体导航线路)！
    const curPos = truckMarker.getPosition();
    const curLngLat = [curPos.lng, curPos.lat];
    currentAnimPos = [...curLngLat];
    currentAnimHeading = currentVehicleHeading;
    map.setZoom(15.5);
    map.setPitch(42);
    map.setRotation(-currentVehicleHeading);
    const forwardOffsetMeters = 180;
    const targetCenter = getForwardOffsetCoord(curLngLat, forwardOffsetMeters, currentVehicleHeading);
    map.setCenter(targetCenter);
    updateVehicleOrientationAndMap(curLngLat, null);

    // 6. 开启手机硬件 GPS 监听
    startRealGpsMode();

    // 7. 联动：启动慢速平稳前向行驶推流（慢速舒适模式，车速真实平缓）
    // 当手机硬件产生真实位移时，真机 GPS 数据会无缝自动覆盖
    simulator.setSpeedMode('SLOW');
    if (trafficLayer) trafficLayer.show();
    simulator.startNormal();

    appendLog('success', '【高德车头朝上导航启动】车头朝上，前方具体导航线路已居中高清呈现，偏航监控中...');
  }

  // 🛑 核心：司机点击【结束导航】
  function stopDriverLiveNavigation() {
    isDriverNavActive = false;

    window.audioAlarm.speak('本次货运导航已结束，感谢您的配合！');

    // 释放屏幕休眠锁
    if (wakeLockSentinel) {
      wakeLockSentinel.release().catch(() => {});
      wakeLockSentinel = null;
    }

    // 停止真实 GPS 与仿真推流
    stopRealGpsMode();
    simulator.stop();

    // 恢复全景视角
    map.setPitch(0);
    map.setRotation(0);
    if (plannedPolylineLayer) {
      map.setFitView([plannedPolylineLayer], false, [50, 50, 50, 50]);
    }
    document.querySelector('.phone-mockup-frame')?.classList.remove('deviation-strobe');

    // 恢复路线确认卡片，隐藏驾驶中 HUD 与右侧光柱
    const rightDock = document.getElementById('amapRightDock');
    if (driverRouteConfirmCard) driverRouteConfirmCard.style.display = 'block';
    if (driverInnavTop) driverInnavTop.style.display = 'none';
    if (driverInnavBottom) driverInnavBottom.style.display = 'none';
    if (rightDock) rightDock.style.display = 'none';

    appendLog('info', '【司机导航已结束】已退出驾驶导航模式，恢复至全景路线规划状态。');
  }

  if (btnConfirmStartNav) btnConfirmStartNav.addEventListener('click', startDriverLiveNavigation);
  if (btnInnavStopNav) btnInnavStopNav.addEventListener('click', stopDriverLiveNavigation);

  // 导航中居中跟随：重新锁定下沉车头朝上视角，完整展现前方导航路线
  if (btnInnavRecenter) {
    btnInnavRecenter.addEventListener('click', () => {
      autoFollow = true;
      const curPos = truckMarker.getPosition();
      const curLngLat = [curPos.lng, curPos.lat];
      const forwardOffsetMeters = 180;
      const targetCenter = getForwardOffsetCoord(curLngLat, forwardOffsetMeters, currentVehicleHeading);
      map.setZoom(15.5);
      map.setCenter(targetCenter);
      map.setRotation(-currentVehicleHeading);
      map.setPitch(is3DModeActive ? 42 : 0);
      appendLog('info', '【居中跟车】已重新锁定车头朝上视角，前方具体导航路线已清晰呈现');
    });
  }

  // 导航中全览路线总览
  const btnInnavOverview = document.getElementById('btnInnavOverview');
  if (btnInnavOverview) {
    btnInnavOverview.addEventListener('click', () => {
      autoFollow = false;
      map.setPitch(0);
      map.setRotation(0);
      if (plannedPolylineLayer) {
        map.setFitView([plannedPolylineLayer], false, [40, 40, 40, 40]);
        appendLog('info', '【路线全览】已展开全景总览，点击「居中跟车」可重新锁定车头朝上');
      }
    });
  }

  // 导航中语音开关联动
  if (btnInnavToggleAudio) {
    btnInnavToggleAudio.addEventListener('click', () => {
      const isMuted = window.audioAlarm.toggleMute();
      const icon = document.getElementById('innavAudioIcon');
      if (icon) icon.textContent = isMuted ? '🔇' : '🔊';
      appendLog('info', isMuted ? '【语音提示】已静音' : '【语音提示】已恢复语音播报');
    });
  }

  // 导航界面右侧浮标：司机一键快速触发偏航模拟测试
  const btnQuickDeviateSim = document.getElementById('btnQuickDeviateSim');
  if (btnQuickDeviateSim) {
    btnQuickDeviateSim.addEventListener('click', () => {
      if (isRealGpsMode) stopRealGpsMode();
      simulator.startDeviate();
      appendLog('warn', '【司机偏航测试】已模拟车辆下道偏航，检验全屏红色报警、距离提示与声光告警...');
    });
  }

  // 底部唤起高德原生 App
  const btnInnavWakeAmap = document.getElementById('btnInnavWakeAmap');
  if (btnInnavWakeAmap) {
    btnInnavWakeAmap.addEventListener('click', () => {
      const btn = document.getElementById('btnLaunchAmapApp');
      if (btn) btn.click();
    });
  }

  // 司机卡片中直接唤起手机高德App
  if (btnDriverWakeAmapApp) {
    btnDriverWakeAmapApp.addEventListener('click', () => {
      const btn = document.getElementById('btnLaunchAmapApp');
      if (btn) btn.click();
    });
  }

  // 右侧 3D 俯视驾驶视角切换
  const btnToggle3DView = document.getElementById('btnToggle3DView');
  const icon3DMode = document.getElementById('icon3DMode');

  if (btnToggle3DView) {
    btnToggle3DView.addEventListener('click', () => {
      is3DModeActive = !is3DModeActive;
      map.setPitch(is3DModeActive ? 40 : 0);
      if (icon3DMode) icon3DMode.textContent = is3DModeActive ? '2D' : '3D';
      appendLog('info', is3DModeActive ? '【视角切换】已开启 3D 俯视驾驶视角' : '【视角切换】已恢复 2D 平面导航视角');
    });
  }

  // 仿真推流速度切换 (🐢 慢速真实体感 -> 🚗 标准巡航 -> ⚡ 极速快进)
  const btnToggleSimSpeed = document.getElementById('btnToggleSimSpeed');
  const iconSimSpeed = document.getElementById('iconSimSpeed');
  const lblSimSpeed = document.getElementById('lblSimSpeed');
  const speedModes = [
    { mode: 'SLOW', icon: '🐢', lbl: '慢速', cls: 'speed-slow', desc: '慢速观摩模式 (时速 ~75km/h，极度平稳细腻)' },
    { mode: 'NORMAL', icon: '🚗', lbl: '巡航', cls: 'speed-normal', desc: '标准巡航模式 (时速 ~120km/h)' },
    { mode: 'FAST', icon: '⚡', lbl: '快进', cls: 'speed-fast', desc: '极速推流模式 (全景加速测试)' }
  ];
  let curSpeedModeIdx = 0; // 默认启用 SLOW 慢速

  if (btnToggleSimSpeed) {
    btnToggleSimSpeed.addEventListener('click', () => {
      curSpeedModeIdx = (curSpeedModeIdx + 1) % speedModes.length;
      const cur = speedModes[curSpeedModeIdx];
      simulator.setSpeedMode(cur.mode);
      if (iconSimSpeed) iconSimSpeed.textContent = cur.icon;
      if (lblSimSpeed) lblSimSpeed.textContent = cur.lbl;
      btnToggleSimSpeed.className = `amap-float-btn ${cur.cls}`;
      appendLog('info', `【推流速度调节】已切换为 ${cur.desc}`);
    });
  }

  // 高德官方实时路况图层开/关切换
  const btnToggleTrafficLayer = document.getElementById('btnToggleTrafficLayer');
  const lblTrafficStatus = document.getElementById('lblTrafficStatus');

  if (btnToggleTrafficLayer) {
    btnToggleTrafficLayer.addEventListener('click', () => {
      isTrafficVisible = !isTrafficVisible;
      if (trafficLayer) {
        if (isTrafficVisible) {
          trafficLayer.show();
          btnToggleTrafficLayer.classList.add('active-traffic');
          if (lblTrafficStatus) lblTrafficStatus.textContent = '路况开';
          appendLog('info', '【高德实时路况】已开启路面实时交通态势图层 (展示红黄绿路况流)');
        } else {
          trafficLayer.hide();
          btnToggleTrafficLayer.classList.remove('active-traffic');
          if (lblTrafficStatus) lblTrafficStatus.textContent = '路况关';
          appendLog('info', '【高德实时路况】已隐藏路面实时路况图层');
        }
      }
    });
  }

  // 罗盘浮动按钮：点击回正视角并锁定车辆跟随
  const btnToggleHeadingUp = document.getElementById('btnToggleHeadingUp');
  if (btnToggleHeadingUp) {
    btnToggleHeadingUp.addEventListener('click', () => {
      autoFollow = true;
      const curPos = truckMarker.getPosition();
      const curLngLat = [curPos.lng, curPos.lat];
      map.setCenter(curLngLat);
      map.setRotation(-currentVehicleHeading);
      map.setPitch(is3DModeActive ? 40 : 0);
      appendLog('info', '【罗盘回正】已居中对准车辆位置，锁定车头朝上导航');
    });
  }

  // 初始化路线元数据同步至前端卡片
  syncRouteInfoToUI();
  renderRouteCandidateChips();

  // 默认启动模式进入：手机司机导航模式 (带手机尺寸模拟框)
  setViewMode('DRIVER');
});

