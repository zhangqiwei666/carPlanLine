/**
 * 离线存储与弱网断点续传引擎 (模拟移动端 SQLite / 本地持久化缓存队列)
 */
class OfflineStorageEngine {
  constructor() {
    this.storageKey = 'TRUCK_PENDING_GPS_QUEUE';
    this.uploadedCount = 0;
    this.uploadApiUrl = ''; // 可选：真实后端数据接收接口
    this.lastUploadedItem = null;
    this.onUploadSuccess = null;
    this.onQueueChange = null;
    this.isOnline = typeof navigator !== 'undefined' ? navigator.onLine !== false : true;
    this.isFlushing = false;
    this.maxQueueSize = 5000;
  }

  /**
   * 模拟写入本地离线数据库 (断网/弱网无条件先存)
   */
  enqueue(gpsPoint) {
    const queue = this.getQueue();
    const record = {
      id: Date.now() + '_' + Math.random().toString(36).substring(2, 6),
      data: gpsPoint,
      createTime: Date.now(),
      status: 0 // 0: 待上报, 1: 已成功
    };
    queue.push(record);

    // 防爆仓上限裁剪
    if (queue.length > this.maxQueueSize) {
      queue.splice(0, queue.length - this.maxQueueSize);
    }

    try {
      localStorage.setItem(this.storageKey, JSON.stringify(queue));
    } catch (e) {
      console.warn('本地离线队列存储异常:', e);
    }

    if (this.onQueueChange) {
      this.onQueueChange(queue.length, this.uploadedCount);
    }

    // 如果网络在线且不在发送中，尝试立即消费
    if (this.isOnline && !this.isFlushing) {
      this.flushQueue();
    }
  }

  getQueue() {
    try {
      const raw = localStorage.getItem(this.storageKey);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  /**
   * 网络恢复或正常在线，批量打包上传 (带防并发和非2xx校验)
   */
  async flushQueue() {
    if (!this.isOnline || this.isFlushing) return;
    const queue = this.getQueue();
    if (queue.length === 0) return;

    this.isFlushing = true;
    const pendingBatch = [...queue];
    const pendingIds = new Set(pendingBatch.map(item => item.id));

    try {
      // 如果配置了真实后端接口，发起真实 HTTP POST 请求
      if (this.uploadApiUrl) {
        const resp = await fetch(this.uploadApiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ batch: pendingBatch, truckPlate: '粤B·8890A', reportTime: Date.now() })
        });
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
        }
      } else {
        // 模拟 50ms 网络握手时延
        await new Promise(r => setTimeout(r, 50));
      }

      // 上传成功：只剔除本次成功发送的 ID，保留网络发送期间新写入的数据
      const currentQueue = this.getQueue();
      const remainingQueue = currentQueue.filter(item => !pendingIds.has(item.id));
      localStorage.setItem(this.storageKey, JSON.stringify(remainingQueue));

      this.uploadedCount += pendingBatch.length;
      this.lastUploadedItem = pendingBatch[pendingBatch.length - 1];

      if (this.onQueueChange) {
        this.onQueueChange(remainingQueue.length, this.uploadedCount, pendingBatch);
      }
      if (this.onUploadSuccess) {
        this.onUploadSuccess({
          batchCount: pendingBatch.length,
          totalUploaded: this.uploadedCount,
          latest: this.lastUploadedItem,
          time: new Date().toLocaleTimeString()
        });
      }
    } catch (err) {
      console.warn('后端上报接口通信失败，保留待发状态:', err.message);
    } finally {
      this.isFlushing = false;
      // 若发送期间又有新数据进队且仍在线，继续处理
      const afterQueue = this.getQueue();
      if (afterQueue.length > 0 && this.isOnline) {
        setTimeout(() => this.flushQueue(), 100);
      }
    }
  }

  setNetworkStatus(isOnline) {
    this.isOnline = isOnline;
    if (this.onQueueChange) {
      const q = this.getQueue();
      this.onQueueChange(q.length, this.uploadedCount);
    }
    if (isOnline) {
      // 联网立即触发补发
      this.flushQueue();
    }
  }

  clear() {
    localStorage.removeItem(this.storageKey);
    this.uploadedCount = 0;
    if (this.onQueueChange) {
      this.onQueueChange(0, 0);
    }
  }
}

window.offlineStorage = new OfflineStorageEngine();
