/**
 * 百度地图版 - 行车轨迹仿真控制器 (模拟真实路况平滑慢速巡航、路况测速、偏航下道、隧道断网)
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
    this.speedMode = 'SLOW';
  }

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
        return { interval: 650, step: 1 };
      case 'NORMAL':
        return { interval: 400, step: 2 };
      case 'FAST':
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
        this.currentIndex = 0;
      }

      const ratio = this.currentIndex / (line.length - 1);
      const trafficInfo = this.routeEngine.getTrafficConditionAtRatio ? this.routeEngine.getTrafficConditionAtRatio(ratio) : null;

      const basePt = line[this.currentIndex];
      this.currentPosition = [basePt[0], basePt[1]];

      const baseSpeed = trafficInfo ? trafficInfo.speed : 75;
      this.truckSpeed = Math.max(15, Math.round(baseSpeed + (Math.random() - 0.5) * 4));

      // 向前取 4 个节点计算平顺切线航向 (0~360度)
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
        roadName: trafficInfo ? trafficInfo.label : '广深沿江高速 (百度合规专线)',
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

      // 强行向西北非标支线偏移
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
        roadName: tunnelTicks <= 6 ? '狮子洋特长隧道 (弱网/卫星遮挡)' : '广深沿江高速 (出隧道已连网)',
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
