/**
 * 智能货运监控平台主调度程序 (App Main Controller - 移动端/真机适配版)
 */
document.addEventListener('DOMContentLoaded', () => {
  // 1. 初始化高德开放平台官方原生 WebGL 3D 矢量地图 (高精 GCJ-02，全景支持 3D 导航与车头朝上透视)
  const map = new AMap.Map('map', {
    viewMode: '3D',
    pitch: 0,
    rotation: 0,
    zoom: 12,
    showLabel: true,
    features: ['bg', 'road', 'building', 'point'],
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
  let candidateBackupLayers = [];
  let roadSignMarkers = [];
  let corridorPolygonLayer = null;
  let actualTrackLayer = null;
  let truckMarker = null;
  let accuracyCircle = null;
  let startMarker = null;
  let endMarker = null;
  let viaMarkers = [];
  let toastTimer = null;

  function showToast(message, type = 'info', duration = 2600) {
    const el = document.getElementById('uiToastNotification');
    if (!el) return;
    if (toastTimer) clearTimeout(toastTimer);
    el.className = `ui-toast-notification visible ${type === 'loading' ? 'toast-loading' : (type === 'success' ? 'toast-success' : '')}`;
    el.textContent = message;
    if (duration > 0) {
      toastTimer = setTimeout(() => {
        el.classList.remove('visible');
      }, duration);
    }
  }

  // 途经点 (中间节点) 响应式状态列表: [{ id, value }]
  let viaPointsState = [{ id: 1, value: '' }];

  // 路线偏好 (权重与策略选择): 'default' | 'avoid_congestion' | 'avoid_highway' | 'avoid_toll' | 'highway_first'
  let currentRoutePreference = 'default';

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
    if (viaMarkers && viaMarkers.length) {
      map.remove(viaMarkers);
      viaMarkers = [];
    }
    if (candidateBackupLayers.length) {
      map.remove(candidateBackupLayers);
      candidateBackupLayers = [];
    }
    if (roadSignMarkers.length) {
      map.remove(roadSignMarkers);
      roadSignMarkers = [];
    }

    // 若高德返回了多条候选方案，在地图上同步绘制备选灰蓝折线，支持点击切换
    const candidates = window.routeEngine.candidateRoutes || [];
    const activeIdx = window.routeEngine.activeCandidateIndex || 0;
    if (!isDriverNavActive && candidates.length > 1) {
      candidates.forEach((cand, idx) => {
        if (idx === activeIdx || !cand.coords || cand.coords.length < 2) return;
        const backupPoly = new AMap.Polyline({
          path: cand.coords,
          isOutline: true,
          outlineColor: '#1e293b',
          borderWeight: 1,
          strokeColor: '#64748b',
          strokeOpacity: 0.78,
          strokeWeight: 8,
          strokeLineJoin: 'round',
          strokeLineCap: 'round',
          showDir: true,
          cursor: 'pointer',
          zIndex: 25 + idx
        });
        backupPoly.on('click', () => {
          applyCandidateRoute(idx);
        });
        map.add(backupPoly);
        candidateBackupLayers.push(backupPoly);
      });
    }

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

    const markersToAdd = [startMarker, endMarker];
    if (window.routeEngine.viaPoints && window.routeEngine.viaPoints.length > 0) {
      window.routeEngine.viaPoints.forEach((coord, idx) => {
        const name = (window.routeEngine.viaNames && window.routeEngine.viaNames[idx]) || `途经点${idx + 1}`;
        const vMarker = new AMap.Marker({
          position: coord,
          content: `<div class="amap-custom-via-marker" title="途经点${idx + 1}: ${name}">途${idx + 1}</div>`,
          offset: new AMap.Pixel(-12, -12),
          title: `途经点${idx + 1}: ${name}`,
          zIndex: 50
        });
        viaMarkers.push(vMarker);
        markersToAdd.push(vMarker);
      });
    }

    // 标记沿途高速名称与主干道路牌标注 (如：大广高速、京港澳高速、长深高速等)
    let badgesToRender = window.routeEngine.majorRoadBadges || [];
    if ((!badgesToRender || badgesToRender.length === 0) && window.routeEngine.trafficSegments && lngLats.length > 10) {
      // 预设示范路线保底生成高速/干线名称路牌
      badgesToRender = window.routeEngine.trafficSegments
        .filter(s => s.label && (s.endRatio - s.startRatio) >= 0.14)
        .slice(0, 4)
        .map(s => {
          const midRatio = (s.startRatio + s.endRatio) / 2;
          const ptIdx = Math.min(lngLats.length - 1, Math.max(0, Math.floor(lngLats.length * midRatio)));
          const segKm = (((window.routeEngine.totalDistanceMeters || 100000) * (s.endRatio - s.startRatio)) / 1000).toFixed(0);
          return {
            name: s.label,
            distanceKm: Number(segKm),
            coord: lngLats[ptIdx],
            isHighway: s.label.includes('高速') || s.label.includes('大桥'),
            isNational: s.label.includes('国道') || s.label.includes('快速')
          };
        });
    }

    if (badgesToRender && badgesToRender.length > 0) {
      badgesToRender.forEach((b, bIdx) => {
        if (!b.coord) return;
        const badgeTypeClass = b.isHighway ? 'highway' : (b.isNational ? 'national' : 'trunk');
        const distLabel = b.distanceKm >= 1 ? `${Math.round(b.distanceKm)}km` : '';
        const signEl = document.createElement('div');
        signEl.className = `map-road-name-sign ${badgeTypeClass}`;
        signEl.title = `点击放大查看【${b.name}】具体道路细节`;
        signEl.innerHTML = `
          <span class="road-sign-tag">${b.isHighway ? '高速' : (b.isNational ? '国/快' : '干线')}</span>
          <strong class="road-sign-name">${b.name}</strong>
          ${distLabel ? `<span class="road-sign-km">${distLabel}</span>` : ''}
        `;
        signEl.addEventListener('click', (e) => {
          e.stopPropagation();
          autoFollow = false;
          map.setPitch(32);
          map.setZoomAndCenter(13.8, b.coord);
          showToast(`🔍 已放大定位至【${b.name}】具体路段（行驶约 ${distLabel || '主干道'}）`, 'success', 2800);
        });
        const rMarker = new AMap.Marker({
          position: b.coord,
          content: signEl,
          offset: new AMap.Pixel(-52, -14),
          zIndex: 55 + bIdx
        });
        roadSignMarkers.push(rMarker);
        markersToAdd.push(rMarker);
      });
    }

    map.add(markersToAdd);

    // 同步渲染地图顶部沿途高速/道路快速放大巡检条
    const roadJumpContainer = document.getElementById('mapRoadJumpChips');
    if (roadJumpContainer) {
      roadJumpContainer.innerHTML = '';
      const jumpItems = [
        { label: '🚀 起点路段', coord: startPt, zoom: 15, pitch: 40 },
        ...(badgesToRender || []).map(b => ({
          label: `🛣️ ${b.name}`,
          coord: b.coord,
          zoom: 13.6,
          pitch: 32
        })),
        { label: '🎯 终点路段', coord: endPt, zoom: 15, pitch: 40 }
      ];
      jumpItems.forEach((item) => {
        if (!item.coord) return;
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'road-jump-chip';
        chip.textContent = item.label;
        chip.title = `点击将地图比例尺放大到【${item.label}】查看具体道路与高速名称`;
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          autoFollow = false;
          roadJumpContainer.querySelectorAll('.road-jump-chip').forEach(c => c.classList.remove('active'));
          chip.classList.add('active');
          map.setPitch(item.pitch || 35);
          map.setZoomAndCenter(item.zoom || 14, item.coord);
          showToast(`🔍 已放大展示【${item.label}】具体线路与周边道路名称`, 'success', 2600);
        });
        roadJumpContainer.appendChild(chip);
      });
    }

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
    const confirmMid = document.querySelector('.od-col-mid .od-arrow-line');

    if (confirmStart) confirmStart.textContent = window.routeEngine.startName || '漯河双汇大厦';
    if (confirmEnd) confirmEnd.textContent = window.routeEngine.endName || '唐山双汇食品有限责任公司';
    if (confirmDist) confirmDist.textContent = `${(window.routeEngine.totalDistanceMeters / 1000).toFixed(1)} km`;
    if (confirmDur) confirmDur.textContent = `${Math.round(window.routeEngine.durationSeconds / 60) || 102}`;
    if (confirmMid) {
      const vNames = (window.routeEngine.viaNames || []).filter(Boolean);
      const vCount = (window.routeEngine.viaPoints && window.routeEngine.viaPoints.length) || 0;
      if (vCount > 0) {
        const labelStr = vNames.length > 0 ? vNames.join(' · ') : `${vCount}个途经点`;
        confirmMid.textContent = `➔ 途经: ${labelStr} ➔`;
      } else {
        confirmMid.textContent = `➔ ${window.routeEngine.highway || '全程直达'} ➔`;
      }
    }
    const hintEl = document.querySelector('.od-col-mid .od-change-hint');
    if (hintEl) {
      const vCount = (window.routeEngine.viaPoints && window.routeEngine.viaPoints.length) || 0;
      hintEl.textContent = vCount > 0 ? `查看/编辑 ${vCount} 个途经点 ❯` : '添加途经点 / 换路线 ❯';
    }
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
      path: [startCoord, startCoord],
      strokeColor: '#10b981',
      strokeOpacity: 0.9,
      strokeWeight: 6,
      strokeLineJoin: 'round'
    });
    actualTrackLayer.hide();
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
      if (actualTrackPoints.length >= 2) {
        actualTrackLayer.setPath(actualTrackPoints);
        actualTrackLayer.show();
      }

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
    if (actualTrackPoints.length >= 2) {
      actualTrackLayer.setPath(actualTrackPoints);
      actualTrackLayer.show();
    }

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
        // window.audioAlarm.speak(matchedMilestone.voiceText);
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

  // 解析前端货车规格输入框 (长/宽/高 及 吨位/轴数)
  function parseTruckParams() {
    const dimInput = (document.getElementById('truckDimensions')?.value || '13.5 / 2.55 / 4.0').trim();
    const weightInput = (document.getElementById('truckWeight')?.value || '36.0 吨 / 6 轴').trim();

    // 提取数字 (支持浮点数)
    const dimMatches = dimInput.match(/[0-9]+(?:\.[0-9]+)?/g) || [];
    let length = dimMatches[0] ? parseFloat(dimMatches[0]) : 13.5;
    let width = dimMatches[1] ? parseFloat(dimMatches[1]) : 2.55;
    let height = dimMatches[2] ? parseFloat(dimMatches[2]) : 4.0;

    // 若用户仅修改输入了 1 个数值 (例如只填了高度 4.5)
    if (dimMatches.length === 1) {
      const v = parseFloat(dimMatches[0]);
      if (v >= 3.0 && v <= 5.5) height = v;
      else if (v > 1.5 && v < 3.2) width = v;
      else if (v > 6.0) length = v;
    }

    const weightMatches = weightInput.match(/[0-9]+(?:\.[0-9]+)?/g) || [];
    let weight = weightMatches[0] ? parseFloat(weightMatches[0]) : 36.0;
    let axis = weightMatches[1] ? parseInt(weightMatches[1], 10) : 6;

    // 智能推断高德货车分类尺寸 (size: 1微型/2轻型/3中型/4重型大件)
    let size = 4;
    if (length < 6.0 && weight < 4.5) size = 1;
    else if (length < 9.0 && weight < 12.0) size = 2;
    else if (length < 12.0 && weight < 25.0) size = 3;
    else size = 4;

    return { length, width, height, weight, axis, size };
  }

  // ============================================================
  // 高德起终点与多途经点 (中间节点) 响应式管理
  // ============================================================
  function renderViaPointsUI() {
    const containers = [
      document.getElementById('viaPointsContainerMain'),
      document.getElementById('viaPointsContainerModal')
    ].filter(Boolean);

    containers.forEach(container => {
      container.innerHTML = '';
      viaPointsState.forEach((item, index) => {
        const row = document.createElement('div');
        row.className = 'via-point-row';
        row.setAttribute('data-via-id', item.id);

        row.innerHTML = `
          <span class="via-dot-icon" title="途经点${index + 1}"></span>
          <input type="text" class="via-point-input" placeholder="请输入途经点${index + 1}" value="${item.value || ''}" />
          <div class="via-row-actions">
            <button type="button" class="btn-input-pin via-pick" title="在地图上点选该途经点">📍</button>
            <button type="button" class="btn-via-remove" title="删除此途经点">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="9"></circle>
                <line x1="8" y1="12" x2="16" y2="12"></line>
              </svg>
            </button>
            <span class="via-drag-handle" title="途经点${index + 1}">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="4" y1="7" x2="20" y2="7"></line>
                <line x1="4" y1="12" x2="20" y2="12"></line>
                <line x1="4" y1="17" x2="20" y2="17"></line>
              </svg>
            </span>
          </div>
        `;

        const input = row.querySelector('.via-point-input');
        input.addEventListener('input', (e) => {
          item.value = e.target.value;
          // 同步另外一个容器中相同 id 的输入框
          containers.forEach(otherC => {
            if (otherC !== container) {
              const otherInp = otherC.querySelector(`[data-via-id="${item.id}"] .via-point-input`);
              if (otherInp && otherInp.value !== e.target.value) {
                otherInp.value = e.target.value;
              }
            }
          });
        });

        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            executeAmapRoutePlanning(false);
          }
        });

        // 删除按钮
        const removeBtn = row.querySelector('.btn-via-remove');
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          removeViaPoint(item.id);
        });

        // 地图点选
        const pickBtn = row.querySelector('.via-pick');
        pickBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          startMapPickingForVia(item.id, index);
        });

        container.appendChild(row);
      });
    });
  }

  function addViaPoint(defaultValue = '') {
    if (viaPointsState.length >= 10) {
      appendLog('warn', '最多支持添加 10 个途经点');
      return;
    }
    const newId = Date.now() + Math.floor(Math.random() * 1000);
    viaPointsState.push({ id: newId, value: defaultValue });
    renderViaPointsUI();
    // 聚焦新建的输入框
    setTimeout(() => {
      const inputs = document.querySelectorAll(`.via-point-row[data-via-id="${newId}"] .via-point-input`);
      if (inputs.length > 0) inputs[0].focus();
    }, 50);
  }

  function removeViaPoint(id) {
    viaPointsState = viaPointsState.filter(v => v.id !== id);
    renderViaPointsUI();
  }

  function swapStartAndEnd() {
    const startInp = document.getElementById('startPointInput');
    const endInp = document.getElementById('endPointInput');
    const modalStartInp = document.getElementById('modalStartInput');
    const modalEndInp = document.getElementById('modalEndInput');

    const sVal = startInp ? startInp.value : '';
    const eVal = endInp ? endInp.value : '';

    if (startInp) startInp.value = eVal;
    if (endInp) endInp.value = sVal;
    if (modalStartInp) modalStartInp.value = eVal;
    if (modalEndInp) modalEndInp.value = sVal;

    // 若有多个途经点，反向倒序
    if (viaPointsState.length > 1) {
      viaPointsState.reverse();
      renderViaPointsUI();
    }

    appendLog('info', '【起终点已互换】正在以此路线重新规划...');
    executeAmapRoutePlanning(false);
  }

  function startMapPickingForVia(viaId, viaIndex) {
    mapPickingTarget = 'VIA_' + viaId;
    map.getContainer().style.cursor = 'crosshair';
    appendLog('info', `【地图选点模式】请直接在地图上点击设为【途经点 ${viaIndex + 1}】！`);
    closeMobileSidebar();
    closeRouteSwitchModal();
  }

  // 货车路线偏好 (支持组合多选，完整覆盖高德 v4/direction/truck 官方 strategy 1~13)
  let selectedPrefTags = new Set(['default']);
  let currentTruckStrategyInfo = {
    code: '11',
    name: '高德推荐',
    desc: '11, 高德推荐：考虑路况，躲避拥堵、速度优先及避免收费（对应SDK策略10）'
  };

  function computeTruckStrategyFromTags(tags) {
    if (tags.has('distance_first')) {
      return {
        code: '13',
        name: '不考虑路况距离优先',
        desc: '13, 不考虑路况距离优先：不考虑当前路况，按道路里程最短规划路径'
      };
    }
    if (tags.has('no_traffic_speed')) {
      if (tags.has('avoid_highway')) {
        return {
          code: '12',
          name: '无路况+不走高速',
          desc: '12, 无路况+不走高速：基于历史通行速度数据，不考虑路况且不走高速路线'
        };
      }
      return {
        code: '10',
        name: '无路况速度优先',
        desc: '10, 无路况速度优先：基于历史通行速度数据，不考虑当前路况，返回速度优先路线'
      };
    }

    const cg = tags.has('avoid_congestion');
    const nh = tags.has('avoid_highway');
    const nt = tags.has('avoid_toll');
    const hf = tags.has('highway_first');

    if (cg && nt && nh) {
      return {
        code: '7',
        name: '躲避拥堵+避免收费+不走高速',
        desc: '7, 躲避拥堵+避免收费+不走高速：考虑路况躲避拥堵，规划低收费且不走高速（对应SDK策略18）'
      };
    }
    if (cg && nh) {
      return {
        code: '4',
        name: '躲避拥堵+不走高速',
        desc: '4, 躲避拥堵+不走高速：考虑路况尽量躲避拥堵，并且不走高速（对应SDK策略15）'
      };
    }
    if (nt && nh) {
      return {
        code: '5',
        name: '避免收费+不走高速',
        desc: '5, 避免收费+不走高速：考虑路况尽量不走高速，且规划收费较低或免费路径（对应SDK策略16）'
      };
    }
    if (cg && nt) {
      return {
        code: '6',
        name: '躲避拥堵+避免收费',
        desc: '6, 躲避拥堵+避免收费：考虑路况尽量躲避拥堵，且规划收费较低或免费路径（对应SDK策略17）'
      };
    }
    if (cg && hf) {
      return {
        code: '9',
        name: '躲避拥堵+高速优先',
        desc: '9, 躲避拥堵+高速优先：优先考虑高速路，并且考虑路况躲避拥堵（对应SDK策略20）'
      };
    }
    if (cg) {
      return {
        code: '1',
        name: '躲避拥堵',
        desc: '1, 躲避拥堵：返回结果考虑路况，尽量躲避拥堵而规划路径（对应SDK策略12）'
      };
    }
    if (nh) {
      return {
        code: '2',
        name: '不走高速',
        desc: '2, 不走高速：返回结果考虑路况，不走高速（对应SDK策略13）'
      };
    }
    if (nt) {
      return {
        code: '3',
        name: '避免收费',
        desc: '3, 避免收费：返回结果考虑路况，尽可能规划收费较低甚至免费的路径（对应SDK策略14）'
      };
    }
    if (hf) {
      return {
        code: '8',
        name: '高速优先',
        desc: '8, 高速优先：返回结果考虑路况，优先选择高速路（对应SDK策略19）'
      };
    }
    return {
      code: '11',
      name: '高德推荐',
      desc: '11, 高德推荐：考虑路况，躲避拥堵、速度优先及避免收费（对应SDK策略10）'
    };
  }

  function setRoutePreference(pref) {
    if (!pref) return;

    if (pref === 'default') {
      selectedPrefTags.clear();
      selectedPrefTags.add('default');
    } else if (pref === 'distance_first') {
      selectedPrefTags.clear();
      selectedPrefTags.add('distance_first');
    } else if (pref === 'no_traffic_speed') {
      selectedPrefTags.delete('default');
      selectedPrefTags.delete('distance_first');
      selectedPrefTags.delete('avoid_congestion');
      selectedPrefTags.delete('avoid_toll');
      selectedPrefTags.delete('highway_first');
      if (selectedPrefTags.has('no_traffic_speed')) {
        selectedPrefTags.delete('no_traffic_speed');
      } else {
        selectedPrefTags.add('no_traffic_speed');
      }
    } else {
      selectedPrefTags.delete('default');
      selectedPrefTags.delete('distance_first');
      if (pref === 'avoid_congestion' || pref === 'avoid_toll' || pref === 'highway_first') {
        selectedPrefTags.delete('no_traffic_speed');
      }
      if (pref === 'highway_first') {
        selectedPrefTags.delete('avoid_highway');
        selectedPrefTags.delete('avoid_toll');
      } else if (pref === 'avoid_highway' || pref === 'avoid_toll') {
        selectedPrefTags.delete('highway_first');
      }
      if (selectedPrefTags.has(pref)) {
        selectedPrefTags.delete(pref);
      } else {
        selectedPrefTags.add(pref);
      }
    }

    if (selectedPrefTags.size === 0) {
      selectedPrefTags.add('default');
    }

    currentTruckStrategyInfo = computeTruckStrategyFromTags(selectedPrefTags);
    currentRoutePreference = currentTruckStrategyInfo.code;

    // 同步主面板与弹窗中的激活态
    document.querySelectorAll('.pref-chip-btn').forEach(btn => {
      const p = btn.getAttribute('data-pref');
      if (selectedPrefTags.has(p)) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    // 同步更新顶部策略徽章与官方说明条
    ['prefStrategyBadgeMain', 'prefStrategyBadgeModal'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = `strategy=${currentTruckStrategyInfo.code} · ${currentTruckStrategyInfo.name}`;
    });
    ['prefStrategyDescMain', 'prefStrategyDescModal'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = currentTruckStrategyInfo.desc;
    });

    appendLog('info', `【货车偏好策略已更新】当前策略：strategy=${currentTruckStrategyInfo.code}【${currentTruckStrategyInfo.name}】，正在调取高德货车规划接口...`);
    executeAmapRoutePlanning(false);
  }

  // 统一高德在线规划执行函数 (直接向云端高德拉取规划路线，支持途经点与货车 strategy 1~13)
  async function executeAmapRoutePlanning(silent = false) {
    const startInput = document.getElementById('startPointInput');
    const endInput = document.getElementById('endPointInput');
    const keyInput = document.getElementById('amapKeyInput');
    const btnAmap = document.getElementById('btnCallAmapApi');

    const startVal = (startInput ? startInput.value : '').trim() || '漯河双汇大厦';
    const endVal = (endInput ? endInput.value : '').trim() || '唐山双汇食品有限责任公司';
    const keyVal = (keyInput ? keyInput.value : '').trim() || '2a03c474e98264d59d1c7b78a06e8701';

    // 提取有效途经点
    const viaPoints = viaPointsState.map(v => v.value.trim()).filter(Boolean);

    // 实时读取用户在界面输入的最新车身长宽高及吨位轴数
    const truckParams = parseTruckParams();

    const originParam = (startVal.includes('当前位置') || startVal.includes('我的位置')) && lastRealCoord
      ? lastRealCoord
      : startVal;
    const destParam = endVal;

    if (btnAmap) {
      btnAmap.disabled = true;
      btnAmap.innerHTML = `<span class="btn-icon">⏳</span> 正在按策略 ${currentTruckStrategyInfo.code}(${currentTruckStrategyInfo.name}) 规划路线...`;
    }

    const viaText = viaPoints.length > 0 ? ` (途径 ${viaPoints.length} 个节点: ${viaPoints.join(' ➔ ')})` : '';
    appendLog('info', `【高德货车 API】发起规划: [${startVal}] 到 [${endVal}]${viaText} | 策略: strategy=${currentTruckStrategyInfo.code} (${currentTruckStrategyInfo.name}) | 车型: ${truckParams.length}m长/限高${truckParams.height}m/${truckParams.axis}轴${truckParams.weight}吨...`);

    try {
      const res = await window.routeEngine.planWithAmapWebApi(
        originParam,
        destParam,
        truckParams,
        keyVal,
        viaPoints,
        currentTruckStrategyInfo.code
      );

      // 重新绘制底图高亮蓝色规划线与动态计算的安全管道缓冲区
      drawBaseRouteAndCorridor();

      // 同步更新司机确认卡片与各 HUD 里程时间、车型限高文本
      syncRouteInfoToUI();

      // 复位小车到新路线的起点
      const newStart = window.routeEngine.highDenseLine[0];
      if (truckMarker && newStart) {
        truckMarker.setPosition(newStart);
      }
      currentAnimPos = newStart ? [...newStart] : [113.483120, 23.098800];
      currentAnimHeading = 0;
      actualTrackPoints.length = 0;
      if (actualTrackLayer) actualTrackLayer.hide();
      dismissDeviationAlarmUI();
      if (simulator) simulator.reset();

      // 自动将视角对准新规划路线
      if (plannedPolylineLayer) {
        map.setFitView([plannedPolylineLayer], false, [60, 60, 60, 60]);
      }

      closeRouteSwitchModal();
      renderRouteCandidateChips();
      appendLog('success', `【高德合规算路成功】已按车高${truckParams.height}m/重${truckParams.weight}t生成 ${res.candidateCount || 3} 条候选方案 | 推荐线: ${(res.distanceMeters / 1000).toFixed(1)}km | 预估耗时: ${Math.round(res.durationSeconds / 60)}分钟！`);
      if (!silent && window.audioAlarm && window.audioAlarm.speak) {
        window.audioAlarm.speak(`路线规划完成，已按${truckParams.length}米、限高${truckParams.height}米货车规格避险，生成 3 条备选路线！`);
      }
      return res;
    } catch (err) {
      appendLog('alarm', `【高德 API 失败】${err.message}`);
      if (!silent) {
        alert(`高德路径规划提示:\n${err.message}\n\n已为您自动保留当前基准路线。您也可以点击输入框上方的“📍 地图选点”直接在地图上点击任意两点规划路线！`);
      }
      throw err;
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

    // 动态同步货车参数与限高显示
    const tp = (window.routeEngine.truckParams) || parseTruckParams();
    const cTruckSpec = document.getElementById('confirmTruckSpec');
    const cTruckHeight = document.getElementById('confirmTruckHeight');
    const modalTruckSpec = document.getElementById('modalTruckSpecSummary');

    if (cTruckSpec) cTruckSpec.textContent = `🚛 ${tp.length}m重卡/${tp.axis}轴/${tp.weight}T`;
    if (cTruckHeight) {
      cTruckHeight.textContent = `⚠️ 限高 ${tp.height}m`;
      cTruckHeight.style.color = tp.height > 4.0 ? '#f87171' : '#f59e0b';
    }
    if (modalTruckSpec) {
      modalTruckSpec.textContent = `🚛 货车参数: ${tp.length}m长车 · ${tp.axis}轴${tp.weight}吨 · 限高${tp.height}米 (高德合规策略自动避险)`;
    }

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
    if (actualTrackLayer) actualTrackLayer.hide();
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

  function renderDynamicWaypointsAndRoadsModalList() {
    const listEl = document.getElementById('dynamicRouteWaypointsList');
    if (!listEl) return;
    listEl.innerHTML = '';

    const sName = window.routeEngine.startName || document.getElementById('startPointInput')?.value || '起运地';
    const eName = window.routeEngine.endName || document.getElementById('endPointInput')?.value || '目的地';
    const line = window.routeEngine.highDenseLine || [];
    const startCoord = line[0];
    const endCoord = line[line.length - 1];
    const viaCoords = window.routeEngine.viaPoints || [];
    const viaNames = window.routeEngine.viaNames || [];
    const roadBadges = window.routeEngine.majorRoadBadges || [];

    const items = [];
    if (startCoord) {
      items.push({
        badge: '起运地',
        badgeCls: 'default',
        title: sName,
        sub: `坐标: ${startCoord[0].toFixed(5)}, ${startCoord[1].toFixed(5)}`,
        meta: '出发集疏运起点',
        coord: startCoord,
        zoom: 15
      });
    }

    viaCoords.forEach((coord, i) => {
      const vName = viaNames[i] || `途经点 ${i + 1}`;
      items.push({
        badge: `必经途经点 ${i + 1}`,
        badgeCls: 'live',
        title: vName,
        sub: `坐标: ${coord[0].toFixed(5)}, ${coord[1].toFixed(5)}`,
        meta: '高德货车规划必经节点',
        coord: coord,
        zoom: 14.5
      });
    });

    roadBadges.forEach((rb) => {
      items.push({
        badge: rb.isHighway ? '途经高速' : '途经干线',
        badgeCls: rb.isHighway ? 'airport' : 'port',
        title: rb.name,
        sub: `本段行驶约 ${rb.distanceKm} 公里`,
        meta: '点击可在地图上放大查看该段具体道路走向',
        coord: rb.coord,
        zoom: 13.8
      });
    });

    if (endCoord) {
      items.push({
        badge: '目的地',
        badgeCls: 'bay',
        title: eName,
        sub: `坐标: ${endCoord[0].toFixed(5)}, ${endCoord[1].toFixed(5)}`,
        meta: `全程约 ${((window.routeEngine.totalDistanceMeters || 0) / 1000).toFixed(1)} 公里`,
        coord: endCoord,
        zoom: 15
      });
    }

    items.forEach((it) => {
      const card = document.createElement('div');
      card.className = 'preset-route-item';
      card.innerHTML = `
        <div class="preset-badge-row">
          <span class="preset-tag ${it.badgeCls}">${it.badge}</span>
          <span class="preset-highway">${it.sub}</span>
        </div>
        <div class="preset-main">
          <div class="preset-od">
            <strong class="p-start">${it.title}</strong>
          </div>
          <div class="preset-meta">
            <span>📍 ${it.meta}</span>
          </div>
        </div>
        <button type="button" class="btn-apply-preset">🔍 地图放大查看</button>
      `;
      card.addEventListener('click', () => {
        closeRouteSwitchModal();
        if (it.coord) {
          autoFollow = false;
          map.setPitch(36);
          map.setZoomAndCenter(it.zoom || 14, it.coord);
          showToast(`🔍 已放大定位至【${it.badge}：${it.title}】`, 'success', 2800);
        }
      });
      listEl.appendChild(card);
    });
  }

  function openRouteSwitchModal() {
    const mainS = document.getElementById('startPointInput');
    const mainE = document.getElementById('endPointInput');
    const modS = document.getElementById('modalStartInput');
    const modE = document.getElementById('modalEndInput');
    if (mainS && modS) modS.value = mainS.value;
    if (mainE && modE) modE.value = mainE.value;

    renderViaPointsUI();
    renderDynamicWaypointsAndRoadsModalList();

    // 默认打开 Tab 1: 起终点与途经点设置
    if (tabCustomRoute && tabPresetRoutes) {
      tabCustomRoute.classList.add('active');
      tabPresetRoutes.classList.remove('active');
      if (contentCustomRoute) contentCustomRoute.style.display = 'block';
      if (contentPresetRoutes) contentPresetRoutes.style.display = 'none';
    }
    if (routeSwitchModal) routeSwitchModal.style.display = 'flex';
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
    titleEl.innerHTML = `<span class="title-full">方案备选 (${candidates.length}条):</span><span class="title-short">方案:</span>`;
    container.appendChild(titleEl);

    candidates.forEach((route, idx) => {
      const btn = document.createElement('button');
      const isCur = idx === activeIdx;
      btn.className = `route-chip-btn ${isCur ? 'active' : ''}`;
      btn.setAttribute('data-candidate-index', idx);
      btn.title = route.desc || route.name;

      const durMin = Math.round(route.durationSeconds / 60);
      const durText = durMin >= 60 ? `${Math.floor(durMin / 60)}h${durMin % 60 ? durMin % 60 + 'm' : ''}` : `${durMin}分`;
      const tollText = route.tolls && route.tolls !== '0' ? `￥${route.tolls}` : '免费';
      const kmText = `${(route.distanceMeters / 1000).toFixed(0)}km`;

      const tagClass = idx === 0 ? 'chip-tag best' : 'chip-tag';
      const tagText = route.tag || `方案${idx + 1}`;

      // 紧凑排版：标签 + 路线核心名 + 关键指标(里程·时间·费用) + 仅在激活项展示详情按钮
      btn.innerHTML = `
        <span class="${tagClass}">${tagText}</span>
        <span class="chip-main-info">
          <strong class="chip-road-name">${route.via || route.name}</strong>
          <span class="chip-metrics-text">${kmText}·${durText}·${tollText}</span>
        </span>
        ${isCur ? '<span class="chip-detail-badge" title="点击查看路线详情与逐段指引">详情 ❯</span>' : ''}
      `;

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        // 若点击的是详情徽章或者当前已经选中的方案，直接打开详情弹窗
        if (e.target.classList.contains('chip-detail-badge') || isCur) {
          applyCandidateRoute(idx);
          openRouteDetailModal(idx);
          return;
        }
        applyCandidateRoute(idx);
      });

      container.appendChild(btn);
    });

    // 右侧功能区：路线详情与换城市快捷入口
    const detailLinkBtn = document.createElement('button');
    detailLinkBtn.type = 'button';
    detailLinkBtn.className = 'route-chip-btn detail-quick-btn';
    detailLinkBtn.id = 'btnChipQuickDetail';
    detailLinkBtn.title = '查看当前方案的逐段导航指引与道路分布';
    detailLinkBtn.innerHTML = '<span>📋 详情 ❯</span>';
    detailLinkBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openRouteDetailModal(window.routeEngine.activeCandidateIndex || 0);
    });
    container.appendChild(detailLinkBtn);

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

  // 打开路线详情弹窗 (高仿高德官方 App 逐段指引与道路聚合面板)
  function openRouteDetailModal(candidateIdx = 0) {
    const modal = document.getElementById('routeDetailModal');
    if (!modal) return;

    const candidates = window.routeEngine.candidateRoutes || [];
    const route = candidates[candidateIdx] || candidates[0];
    if (!route) return;

    // 1. 回填方案标题与徽章
    const titleEl = document.getElementById('detailHeaderTitle');
    const badgeEl = document.getElementById('detailChipBadge');
    if (titleEl) titleEl.textContent = `路线详情 · 方案${candidateIdx + 1}`;
    if (badgeEl) badgeEl.textContent = route.tag || `方案${candidateIdx + 1}`;

    // 2. 回填总里程、预估耗时、过路费
    const kmEl = document.getElementById('modalDetailKm');
    const timeEl = document.getElementById('modalDetailTime');
    const tollsEl = document.getElementById('modalDetailTolls');
    const distKm = (route.distanceMeters / 1000).toFixed(1);
    const durMin = Math.round(route.durationSeconds / 60);
    const timeStr = durMin >= 60 ? `${Math.floor(durMin / 60)}小时${durMin % 60}分` : `${durMin}分钟`;
    const tollStr = route.tolls && route.tolls !== '0' ? `￥${route.tolls}` : '免费';

    if (kmEl) kmEl.textContent = distKm;
    if (timeEl) timeEl.textContent = timeStr;
    if (tollsEl) tollsEl.textContent = tollStr;

    // 3. 回填起点与终点名称
    const sNameEl = document.getElementById('detailStartName');
    const eNameEl = document.getElementById('detailEndName');
    if (sNameEl) sNameEl.textContent = window.routeEngine.startName || '广州黄埔港物流中心';
    if (eNameEl) eNameEl.textContent = window.routeEngine.endName || '东莞清溪智能产业园';

    // 4. 聚合道路步骤列表 (Road Aggregation)
    const listContainer = document.getElementById('detailRoadsList');
    if (listContainer) {
      listContainer.innerHTML = '';
      const roadSegments = [];

      if (route.steps && route.steps.length > 0) {
        // 从高德云端返回的真实 steps 聚合道路 (同时兼容 v5 路径规划2.0 与 v3 字段)
        let curSegment = null;
        route.steps.forEach((step, sIdx) => {
          let roadName = (step.road_name || step.road || '').trim();
          if (!roadName) {
            const m = (step.instruction || '').match(/沿([^向往途径进入\s,，。]+)/);
            roadName = m ? m[1] : (sIdx === 0 ? '出港/场区道路' : (sIdx >= route.steps.length - 2 ? '目的地引道' : '内部道路/连通道'));
          }
          const d = Number(step.step_distance || step.distance || 0);
          const actionText = (step.navi && step.navi.action) ? step.navi.action : (step.action || '直行');
          const lights = step.cost && step.cost.traffic_lights !== undefined ? Number(step.cost.traffic_lights) : 0;

          if (!curSegment || curSegment.name !== roadName) {
            curSegment = {
              name: roadName,
              distance: d,
              action: actionText,
              trafficLights: lights,
              substeps: [step.instruction || '沿路前行']
            };
            roadSegments.push(curSegment);
          } else {
            curSegment.distance += d;
            curSegment.trafficLights += lights;
            curSegment.substeps.push(step.instruction || '沿路前行');
          }
        });
      } else {
        // 离线/静态预设数据下的优雅保底道路段
        const mockRoads = [
          { name: '起运枢纽大道', distance: Math.round(route.distanceMeters * 0.05), action: '直行', trafficLights: 2, substeps: ['从起运物流中心发车', '右转进入主干集疏运通道'] },
          { name: '开发大道互通立交', distance: Math.round(route.distanceMeters * 0.08), action: '右转', trafficLights: 1, substeps: ['沿匝道行驶进入收费站', '进入高速公路主干道'] },
          { name: route.via ? route.via.split('(')[0].trim() : '国家高速主干线', distance: Math.round(route.distanceMeters * 0.72), action: '直行', trafficLights: 0, substeps: ['沿高速主线持续直行巡航', '途经省际交通大动脉', '通过大型枢纽立交'] },
          { name: '目的地产业园连接道', distance: Math.round(route.distanceMeters * 0.15), action: '靠右', trafficLights: 3, substeps: ['从高速出口下匝道', '沿园区快速路直达目标仓库'] }
        ];
        mockRoads.forEach(r => roadSegments.push(r));
      }

      // 渲染每个道路卡片
      roadSegments.forEach((road) => {
        const card = document.createElement('div');
        card.className = 'road-item-card';

        // 转向图标判定
        let iconSymbol = '↑';
        if (road.action.includes('左转')) iconSymbol = '↰';
        else if (road.action.includes('右转')) iconSymbol = '↱';
        else if (road.action.includes('环岛')) iconSymbol = '⤹';
        else if (road.action.includes('靠左')) iconSymbol = '↖';
        else if (road.action.includes('靠右') || road.action.includes('匝道')) iconSymbol = '↗';

        const distText = road.distance >= 1000 ? `${(road.distance / 1000).toFixed(1)}公里` : `${road.distance}米`;
        const substepCount = road.substeps.length;
        const lightsText = `红绿灯${road.trafficLights || 0}个`;

        card.innerHTML = `
          <div class="road-item-node">${iconSymbol}</div>
          <div class="road-main-row">
            <div class="road-name-box">
              <span class="road-name">${road.name}</span>
              <div class="road-meta">
                <span>${distText} ${lightsText}</span>
                <span class="road-meta-tag">${substepCount > 1 ? `${substepCount}段操作` : '畅通直达'}</span>
              </div>
            </div>
            <span class="road-toggle-arrow">▼</span>
          </div>
          <div class="road-substeps-list">
            ${road.substeps.map(s => `<div class="substep-row"><span class="substep-bullet">•</span><span>${s}</span></div>`).join('')}
          </div>
        `;

        // 点击手风琴展开查看细分指令
        card.addEventListener('click', () => {
          card.classList.toggle('expanded');
        });

        listContainer.appendChild(card);
      });
    }

    // 5. 底部按钮绑定
    const applyBtn = document.getElementById('btnDetailApplyCurrentRoute');
    if (applyBtn) {
      applyBtn.onclick = () => {
        applyCandidateRoute(candidateIdx);
        closeRouteDetailModal();
        window.audioAlarm.speak(`已确认选定${route.name}，开始实时导航！`);
      };
    }

    // 显示弹窗
    modal.style.display = 'flex';
  }

  // 关闭路线详情弹窗
  function closeRouteDetailModal() {
    const modal = document.getElementById('routeDetailModal');
    if (modal) modal.style.display = 'none';
  }

  // 绑定详情弹窗关闭交互
  const btnDetailBack = document.getElementById('btnDetailBack');
  const btnDetailClose = document.getElementById('btnDetailClose');
  const routeDetailBackdrop = document.getElementById('routeDetailBackdrop');

  if (btnDetailBack) btnDetailBack.addEventListener('click', closeRouteDetailModal);
  if (btnDetailClose) btnDetailClose.addEventListener('click', closeRouteDetailModal);
  if (routeDetailBackdrop) routeDetailBackdrop.addEventListener('click', closeRouteDetailModal);

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
    if (actualTrackLayer) actualTrackLayer.hide();
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
      const s = document.getElementById('modalStartInput')?.value?.trim() || document.getElementById('startPointInput')?.value?.trim() || '漯河双汇大厦';
      const d = document.getElementById('modalEndInput')?.value?.trim() || document.getElementById('endPointInput')?.value?.trim() || '唐山双汇食品有限责任公司';
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

  // 司机主面板上的“路线详情”按钮点击
  const btnCardOpenRouteDetail = document.getElementById('btnCardOpenRouteDetail');
  if (btnCardOpenRouteDetail) {
    btnCardOpenRouteDetail.addEventListener('click', (e) => {
      e.stopPropagation();
      const activeIdx = window.routeEngine.activeCandidateIndex || 0;
      openRouteDetailModal(activeIdx);
    });
  }

  // 方案备选栏上的“📋 详情”快捷按钮点击
  const btnChipQuickDetail = document.getElementById('btnChipQuickDetail');
  if (btnChipQuickDetail) {
    btnChipQuickDetail.addEventListener('click', (e) => {
      e.stopPropagation();
      const activeIdx = window.routeEngine.activeCandidateIndex || 0;
      openRouteDetailModal(activeIdx);
    });
  }

  // 调取高德官方 API 按钮绑定
  const btnCallAmapApi = document.getElementById('btnCallAmapApi');
  if (btnCallAmapApi) {
    btnCallAmapApi.addEventListener('click', () => executeAmapRoutePlanning(false));
  }

  // 绑定添加途经点与互换起终点按钮
  const btnAddViaMain = document.getElementById('btnAddViaMain');
  if (btnAddViaMain) {
    btnAddViaMain.addEventListener('click', (e) => {
      e.stopPropagation();
      addViaPoint('');
    });
  }
  const btnAddViaModal = document.getElementById('btnAddViaModal');
  if (btnAddViaModal) {
    btnAddViaModal.addEventListener('click', (e) => {
      e.stopPropagation();
      addViaPoint('');
    });
  }
  const btnSwapMain = document.getElementById('btnSwapMain');
  if (btnSwapMain) {
    btnSwapMain.addEventListener('click', (e) => {
      e.stopPropagation();
      swapStartAndEnd();
    });
  }
  const btnSwapModal = document.getElementById('btnSwapModal');
  if (btnSwapModal) {
    btnSwapModal.addEventListener('click', (e) => {
      e.stopPropagation();
      swapStartAndEnd();
    });
  }

  // 起终点输入框双向同步 (主面板 <-> 弹窗)
  const syncInputs = [
    { main: 'startPointInput', modal: 'modalStartInput' },
    { main: 'endPointInput', modal: 'modalEndInput' }
  ];
  syncInputs.forEach(({ main, modal }) => {
    const mainEl = document.getElementById(main);
    const modalEl = document.getElementById(modal);
    if (mainEl && modalEl) {
      mainEl.addEventListener('input', () => { modalEl.value = mainEl.value; });
      modalEl.addEventListener('input', () => { mainEl.value = modalEl.value; });
    }
  });

  // 绑定路线偏好按钮点击 (主面板与弹窗)
  document.querySelectorAll('.pref-chip-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const pref = btn.getAttribute('data-pref');
      if (pref) setRoutePreference(pref);
    });
  });

  // 绑定路线偏好标题折叠/展开
  ['prefHeaderMain', 'prefHeaderModal'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const box = el.closest('.amap-route-preference-box');
        if (box) box.classList.toggle('collapsed');
      });
    }
  });

  // 绑定货车规格与起终点输入框的回车与实时输入监听
  ['startPointInput', 'endPointInput', 'amapKeyInput', 'truckDimensions', 'truckWeight'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          executeAmapRoutePlanning(false);
        }
      });
      // 实时修改长宽高或吨位轴数时，立即重算各方案过路费/耗时并回显至确认卡片、方案栏与地图走廊
      if (id === 'truckDimensions' || id === 'truckWeight') {
        el.addEventListener('input', () => {
          const tp = parseTruckParams();
          if (window.routeEngine.recalculateCandidatesWithTruckParams) {
            window.routeEngine.recalculateCandidatesWithTruckParams(tp);
          }
          syncRouteInfoToUI();
          renderRouteCandidateChips();
          drawBaseRouteAndCorridor();
        });
      }
    }
  });

  // 地图点选设置起终点与途经点功能
  let mapPickingTarget = null; // 'START' | 'END' | 'VIA_<id>' | null

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
    } else if (mapPickingTarget && mapPickingTarget.startsWith('VIA_')) {
      const viaId = parseInt(mapPickingTarget.replace('VIA_', ''), 10);
      const lng = Number(e.lnglat.lng.toFixed(6));
      const lat = Number(e.lnglat.lat.toFixed(6));
      const targetItem = viaPointsState.find(v => v.id === viaId);
      if (targetItem) {
        targetItem.value = `${lng}, ${lat}`;
        renderViaPointsUI();
      }
      mapPickingTarget = null;
      map.getContainer().style.cursor = '';
      appendLog('success', `【已选定途经点】[${lng}, ${lat}]，正在自动调取高德计算最新规划路线...`);
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
      const via = (window.routeEngine.viaPoints && window.routeEngine.viaPoints.length > 0)
        ? window.routeEngine.viaPoints.map((coord, i) => ({
            lng: coord[0],
            lat: coord[1],
            name: (window.routeEngine.viaNames && window.routeEngine.viaNames[i]) || `途经点${i + 1}`
          }))
        : [];

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
    if (actualTrackLayer) actualTrackLayer.hide();
    dismissDeviationAlarmUI();
    const startCoord = window.routeEngine.highDenseLine[0];
    if (truckMarker && startCoord) truckMarker.setPosition(startCoord);
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

  // 视图模式切换 (默认铺满大屏展示高清大地图)
  function setViewMode(mode) {
    if (mode === 'DRIVER') {
      document.body.classList.add('mode-driver');
      document.body.classList.remove('desktop-phone-sim-active');
      if (btnModeDriver) btnModeDriver.classList.add('active');
      if (btnModeDispatch) btnModeDispatch.classList.remove('active');
      if (btnFrameFull) btnFrameFull.classList.add('active');
      if (btnFrameSim) btnFrameSim.classList.remove('active');
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

  // 地图顶部比例尺放大/全览/逐级缩放按钮绑定
  const btnZoomToStreetNav = document.getElementById('btnZoomToStreetNav');
  const btnZoomFitOverview = document.getElementById('btnZoomFitOverview');
  const btnMapZoomIn = document.getElementById('btnMapZoomIn');
  const btnMapZoomOut = document.getElementById('btnMapZoomOut');

  if (btnZoomToStreetNav) {
    btnZoomToStreetNav.addEventListener('click', () => {
      autoFollow = true;
      const line = window.routeEngine.highDenseLine || [];
      const curPos = truckMarker ? truckMarker.getPosition() : null;
      const targetPt = curPos ? [curPos.lng, curPos.lat] : (line[0] || [114.059363, 33.564191]);
      if (line.length >= 2) {
        const b = turf.bearing(turf.point(line[0]), turf.point(line[1]));
        currentVehicleHeading = (b + 360) % 360;
      }
      map.setPitch(42);
      map.setRotation(-currentVehicleHeading);
      map.setZoomAndCenter(15, targetPt);
      showToast('🔍 已切换至手机导航大比例尺视角 (Zoom=15 · 3D车头朝上 · 展示具体道路与高速名称)', 'success', 3200);
    });
  }

  if (btnZoomFitOverview) {
    btnZoomFitOverview.addEventListener('click', () => {
      autoFollow = false;
      map.setPitch(0);
      map.setRotation(0);
      if (plannedPolylineLayer) {
        map.setFitView([plannedPolylineLayer, ...candidateBackupLayers], false, [60, 60, 60, 60]);
      }
      showToast('🗺️ 已恢复全程路线总览视角', 'info', 2200);
    });
  }

  if (btnMapZoomIn) {
    btnMapZoomIn.addEventListener('click', () => {
      const z = Math.min(20, (map.getZoom ? map.getZoom() : 12) + 1.5);
      map.setZoom(z);
    });
  }

  if (btnMapZoomOut) {
    btnMapZoomOut.addEventListener('click', () => {
      const z = Math.max(3, (map.getZoom ? map.getZoom() : 12) - 1.5);
      map.setZoom(z);
    });
  }

  // 初始化渲染途经点动态输入列表
  renderViaPointsUI();

  // 初始化：立即向云端高德拉取最新 3 条规划路线（不再依赖本地数据）
  executeAmapRoutePlanning(true).catch(err => {
    console.warn('云端高德多路线加载异常，降级显示本地路线:', err);
    syncRouteInfoToUI();
    renderRouteCandidateChips();
  });

  // 默认启动模式进入：手机司机导航模式 (带手机尺寸模拟框)
  setViewMode('DRIVER');
});

