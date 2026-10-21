/**
 * 行车轨迹仿真控制器 (模拟真实路况平滑慢速巡航、路况测速、偏航下道、隧道断网)
 */
class TruckDrivingSimulator {
  constructor(routeEngine, onTick, onAlarmTrigger, onRecoverNormal) {
    this.routeEngine = routeEngine;
    this.onTick = onTick;
    this.onAlarmTrigger = onAlarmTrigger;
    this.onRecoverNormal = onRecoverNormal;

    this.timer = null;
    this.currentIndex = 0;
    this.mode = 'IDLE'; // 'NORMAL' | 'DEVIATED' | 'TUNNEL'
    this.currentPosition = null;
    this.truckSpeed = 68; // 默认时速 km/h
    this.deviateStep = 0;
    
    // 仿真推流速度模式：'SLOW' (慢速真实观摩) | 'NORMAL' (标准巡航) | 'FAST' (快进推流)
    // 默认启用 SLOW 慢速舒适模式，平滑细腻地展示高德导航真实路况与转向
    this.speedMode = 'SLOW';
  }

  /**
   * 设置推流速度模式
   * @param {'SLOW' | 'NORMAL' | 'FAST'} mode 
   */
  setSpeedMode(mode = 'SLOW') {
    this.speedMode = mode;
    if (this.timer) {
      if (this.mode === 'NORMAL') this.startNormal();
      else if (this.mode === 'DEVIATED') this.startDeviate();
      else if (this.mode === 'TUNNEL') this.startTunnelOffline();
    }
  }

  getIntervalAndStep() {
    switch (this.speedMode) {
      case 'SLOW':
        // 慢速真实体感：每 650ms 走 1 个点 (~25米)，时速换算约 60~80 km/h，转弯平缓，指引清晰
        return { interval: 650, step: 1 };
      case 'NORMAL':
        // 标准演示巡航：每 400ms 走 2 个点
        return { interval: 400, step: 2 };
      case 'FAST':
        // 快进加速：每 200ms 走 5 个点，快速跑完全程
        return { interval: 200, step: 5 };
      default:
        return { interval: 650, step: 1 };
    }
  }

  startNormal() {
    this.stop();
    this.mode = 'NORMAL';
    this.deviateStep = 0;
    window.offlineStorage.setNetworkStatus(true);

    const { interval, step } = this.getIntervalAndStep();

    this.runLoop(() => {
      const line = this.routeEngine.highDenseLine;
      if (!line || line.length < 2) return null;

      this.currentIndex += step;
      if (this.currentIndex >= line.length - 1) {
        this.currentIndex = 0; // 循环行驶
      }

      const ratio = this.currentIndex / (line.length - 1);
      const trafficInfo = this.routeEngine.getTrafficConditionAtRatio ? this.routeEngine.getTrafficConditionAtRatio(ratio) : null;

      const basePt = line[this.currentIndex];
      // 保持贴合高德真实路网中心线，杜绝任何坐标随机噪点抖动
      this.currentPosition = [basePt[0], basePt[1]];

      // 车速随路况真实变化：拥堵20-28km/h, 缓行35-45km/h, 畅通75-85km/h
      const baseSpeed = trafficInfo ? trafficInfo.speed : 75;
      this.truckSpeed = Math.max(15, Math.round(baseSpeed + (Math.random() - 0.5) * 4));

      // 核心：向前取 3~5 个节点 (~75-120米) 计算道路几何前瞻切线航向，转向极度稳定柔顺
      const aheadIdx = Math.min(line.length - 1, this.currentIndex + 4);
      const aheadPt = line[aheadIdx];
      let heading = null;
      if (aheadPt && (aheadPt[0] !== basePt[0] || aheadPt[1] !== basePt[1]) && window.turf) {
        const b = turf.bearing(turf.point(basePt), turf.point(aheadPt));
        heading = (b + 360) % 360;
      }

      return {
        point: this.currentPosition,
        speed: this.truckSpeed,
        roadName: trafficInfo ? trafficInfo.label : '广深沿江高速 (主干道)',
        trafficInfo: trafficInfo,
        heading: heading,
        duration: interval
      };
    }, interval);
  }

  startDeviate() {
    this.stop();
    this.mode = 'DEVIATED';
    this.deviateStep = 0;
    window.offlineStorage.setNetworkStatus(true);

    const { interval, step } = this.getIntervalAndStep();

    this.runLoop(() => {
      const line = this.routeEngine.highDenseLine;
      if (!line || line.length < 2) return null;

      this.currentIndex += step;
      if (this.currentIndex >= line.length - 1) {
        this.currentIndex = 0;
      }
      this.deviateStep++;

      const basePt = line[this.currentIndex];
      const prevPos = this.currentPosition ? [...this.currentPosition] : [...basePt];

      // 强行偏离主干道（向西北侧省道/非标村道持续深入，偏移距离快速达到 300m ~ 1200m）
      const offsetLat = 0.003 + (this.deviateStep * 0.0008);
      const offsetLng = -0.0025 - (this.deviateStep * 0.0007);

      this.currentPosition = [basePt[0] + offsetLng, basePt[1] + offsetLat];
      this.truckSpeed = 45 + Math.floor(Math.random() * 6);

      let heading = null;
      if (prevPos && (prevPos[0] !== this.currentPosition[0] || prevPos[1] !== this.currentPosition[1]) && window.turf) {
        const b = turf.bearing(turf.point(prevPos), turf.point(this.currentPosition));
        heading = (b + 360) % 360;
      }

      return {
        point: this.currentPosition,
        speed: this.truckSpeed,
        roadName: 'X241 县道 (未经审批的非标路线)',
        trafficInfo: { status: 'deviated', color: '#ef4444', label: '非审批乡道/村道' },
        heading: heading,
        duration: interval
      };
    }, interval);
  }

  startTunnelOffline() {
    this.stop();
    this.mode = 'TUNNEL';
    this.deviateStep = 0;
    
    // 1. 模拟进隧道断网
    window.offlineStorage.setNetworkStatus(false);

    let tunnelTicks = 0;
    const { interval, step } = this.getIntervalAndStep();

    this.runLoop(() => {
      tunnelTicks++;
      const line = this.routeEngine.highDenseLine;
      if (!line || line.length < 2) return null;

      this.currentIndex += step;
      if (this.currentIndex >= line.length - 1) {
        this.currentIndex = 0;
      }

      const basePt = line[this.currentIndex];
      this.currentPosition = [basePt[0], basePt[1]];
      this.truckSpeed = 60;

      // 在隧道里行驶 6 次上报后，模拟出隧道恢复网络
      if (tunnelTicks === 6) {
        window.offlineStorage.setNetworkStatus(true);
      }

      const aheadIdx = Math.min(line.length - 1, this.currentIndex + 4);
      const aheadPt = line[aheadIdx];
      let heading = null;
      if (aheadPt && (aheadPt[0] !== basePt[0] || aheadPt[1] !== basePt[1]) && window.turf) {
        const b = turf.bearing(turf.point(basePt), turf.point(aheadPt));
        heading = (b + 360) % 360;
      }

      return {
        point: this.currentPosition,
        speed: this.truckSpeed,
        roadName: tunnelTicks <= 6 ? '狮子洋长隧道 (无4G/卫星遮挡)' : '广深沿江高速 (出隧道已联网)',
        trafficInfo: { status: 'tunnel', color: '#f59e0b', label: '隧道弱网路段' },
        heading: heading,
        duration: interval
      };
    }, interval);
  }

  runLoop(pointGenerator, interval = 650) {
    this.timer = setInterval(() => {
      const data = pointGenerator();
      if (data && this.onTick) {
        this.onTick(data.point, data.speed, data.roadName, this.mode, data.trafficInfo, data.heading, data.duration);
      }
    }, interval);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  reset() {
    this.stop();
    this.mode = 'IDLE';
    this.currentIndex = 0;
    this.deviateStep = 0;
    this.currentPosition = this.routeEngine.highDenseLine[0];
    window.offlineStorage.setNetworkStatus(true);
    window.offlineStorage.clear();
  }
}

window.TruckDrivingSimulator = TruckDrivingSimulator;
