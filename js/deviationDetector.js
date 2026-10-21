/**
 * 生产级核心偏航判定引擎 (基于 Turf.js 空间分析 + 连续滑动窗口防误报算法)
 */
class DeviationDetector {
  constructor(thresholdMeters = 250, requiredConsecutiveCount = 3) {
    this.thresholdMeters = thresholdMeters; // 距离容差阈值 (米)
    this.requiredConsecutiveCount = requiredConsecutiveCount; // 触发告警所需的连续超限次数

    this.consecutiveOverCount = 0; // 当前连续超限计数器
    this.isAlarmTriggered = false; // 是否已处于报警状态
    this.historyDistances = [];
    this.maxAccuracyMeters = 80; // 定位精度差于此值的点不参与偏航计数 (室内/高楼/隧道漂移)
  }

  setThreshold(meters) {
    this.thresholdMeters = Number(meters);
  }

  /**
   * 判定当前位置是否偏航
   * @param {Array} currentGps [lng, lat]
   * @param {Object} routeGeoJson Turf LineString 对象
   * @param {Number} speed 当前车速 km/h
   * @param {Number} [accuracy] GPS 定位精度 (米)，仿真数据不传
   */
  check(currentGps, routeGeoJson, speed = 60, accuracy = null) {
    const pt = turf.point(currentGps);

    // 核心算法：计算点到折线的最短垂直距离 (单位: 米)
    const distanceKm = turf.pointToLineDistance(pt, routeGeoJson, { units: 'kilometers' });
    const distanceMeters = Math.round(distanceKm * 1000);

    this.historyDistances.push(distanceMeters);
    if (this.historyDistances.length > 10) {
      this.historyDistances.shift();
    }

    // 1. 物理距离判定
    const isOverThreshold = distanceMeters > this.thresholdMeters;
    const isLowAccuracy = accuracy !== null && accuracy > this.maxAccuracyMeters;

    // 2. 连续采样窗口防漂移判定
    if (isOverThreshold) {
      // 精度太差或车辆静止 (靠边停车时 GPS 漂移) 的点不累加计数，但也不清零
      const isStationary = accuracy !== null && speed < 5;
      if (!isLowAccuracy && !isStationary) {
        this.consecutiveOverCount++;
      }
    } else if (!isLowAccuracy) {
      // 一旦可信地回到安全管道内，立即归零
      this.consecutiveOverCount = 0;
      this.isAlarmTriggered = false;
    }

    // 3. 达到连续 N 次且未恢复，触发实质偏航报警
    if (this.consecutiveOverCount >= this.requiredConsecutiveCount) {
      this.isAlarmTriggered = true;
    }

    return {
      distanceMeters,
      isOverThreshold,
      consecutiveCount: this.consecutiveOverCount,
      isAlarm: this.isAlarmTriggered
    };
  }

  reset() {
    this.consecutiveOverCount = 0;
    this.isAlarmTriggered = false;
    this.historyDistances = [];
  }
}

window.deviationDetector = new DeviationDetector();
