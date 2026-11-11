# 智能货运在途监控与实时偏航预警系统 (百度地图 SDK 专版)

本项目是基于**百度地图开放平台 WebGL 引擎 (BMapGL v1.0)** 独立构建的生产级货车导航、运输走廊电子围栏与实时偏航预警系统。

代码完全独立收敛在当前工程的 `baiduMap/` 目录下，与高德版本保持相同的功能规格、相同的设计大纲与架构规范，采用百度官方推荐的 **BD-09 高精坐标体系**。

---

## 🌟 核心特性与架构实现

### 1. 双端视角无缝切换
- 📱 **手机司机导航视图 (Mobile Driver Navigation)**:
  - **3D 沉浸式驾驶舱透视**：俯仰角固定 42°，视角下沉前置 180 米，上方完整展现前方 500+ 米导航线路。
  - **车头朝上 (Heading-Up) 顺滑旋转**：小车图标严格直立，底图随实际航向角柔顺转动。
  - **高精度激光探照车标**：自定义 WebGL HTML 覆盖物 (`CustomHTMLOverlay`)，包含车头探路大灯光束与雷达脉冲光环。
  - **全功能驾驶 HUD**：实时时速表、剩余里程倒计时、预计到达时间 (ETA)、偏离安全走廊距离。
  - **动态全程路况蚯蚓条 (Worm Bar)**：右侧微缩展示全程拥堵、缓行与畅通分段，并实时映射当前车辆行进位置点。
- 🖥️ **企业调度监控大屏 (Enterprise Dispatch Center)**:
  - 2D 正北朝上全局鸟瞰视角，完整展现安全管道走廊全景。
  - 车辆自身随航向旋转，实时回传轨迹连线（绿色正常通行、红色偏航标记）。
  - 支持快捷切换桌面端 iPhone 仿真尺寸 (390×844) 与浏览器铺满模式。

### 2. 百度地图 WebGL 原生接入
- 采用百度官方原生 WebGL 脚本：
  ```html
  <link rel="stylesheet" href="https://api.map.baidu.com/res/webgl/10/bmap.css"/>
  <script src="https://api.map.baidu.com/getscript?type=webgl&v=1.0&ak=09whqfXUN4uBopGVTqxcHOOkgwBV4Ny5"></script>
  ```
- **路线规划引擎 (`baiduEngine.js`)**：
  - 支持调用百度地图 JS API GL 官方算路引擎 (`BMapGL.DrivingRoute`)。
  - 包含百度地理编码解析 (`BMapGL.Geocoder`) 与地图任意坐标点选拾取。
  - 内置 3 套广州黄埔港至东莞清溪的同起终点多路线方案（推荐方案、萝岗绕行方案、广园地面方案）。
  - 支持一键生成唤起司机手机端“百度地图 App”的 URI Scheme：
    `baidumap://map/direction?origin=latlng:lat,lng|name:起运地&destination=latlng:lat,lng|name:目的地&mode=driving&coord_type=bd09ll&src=truck_demo`

### 3. 高精度空间分析与防误报偏航判定
- **Turf.js 空间走廊生成**：基于规划折线快速生成指定半径（默认 ±250m，支持 30m~600m 动态调节）的凸包多边形缓冲区 (`turf.buffer`)。
- **垂直距离算法 (`turf.pointToLineDistance`)**：实时计算车辆当前坐标到走廊中线的最短垂直距离。
- **连续滑动窗口防漂移算法 (`deviationDetector.js`)**：
  - 连续超限 3 次判定实质偏航，消除 GPS 偶发噪点。
  - 精度过滤：定位精度大于 80 米的点不计入报警，杜绝高架下/室内误报。
  - 静止驻车防漂：车速小于 5km/h 且停车时不累加偏航计数。

### 4. 警报与声学系统 (`audioAlarm.js`)
- 基于 **Web Audio API** 纯代码合成 880Hz 与 587Hz 双频紧急工业预警蜂鸣，零外部音频资源依赖。
- 集成 **SpeechSynthesis** 导航语音合成播报（支持一键物理静音）。

### 5. 弱网断点续传与离线存储管道 (`offlineStorage.js`)
- 模拟移动端 SQLite / 本地持久化缓存队列 (`BAIDU_TRUCK_PENDING_GPS_QUEUE`)。
- 模拟隧道失联/弱网自动离线排队，出隧道联网后自动进行防并发批量断点补发，杜绝在途数据遗失。

### 6. 真机物理 GPS 遥测与坐标转换
- 支持浏览器 `navigator.geolocation.watchPosition` 读取手机芯片原生 WGS-84 经纬度。
- 引入高精度坐标转换模块 (`coordTransform.js`)，将国际 WGS-84 经纬度毫秒级转换为百度 **BD-09** 坐标，确保卫星定位与百度底图严格重合。

---

## 📁 目录结构

```text
baiduMap/
├── index.html               # 百度地图版本主页面入口
├── css/
│   └── style.css            # 科技暗黑主题与车载 HUD 样式库
└── js/
    ├── app.js               # 百度地图 WebGL 3D 主控制器 (HUD/小车补间/视图切换)
    ├── baiduEngine.js       # 百度规划引擎 (BMapGL.DrivingRoute / 走廊生成 / 方案切换)
    ├── coordTransform.js    # 坐标转换器 (WGS-84 ⇄ GCJ-02 ⇄ BD-09)
    ├── audioAlarm.js        # Web Audio API 警报与语音合成
    ├── offlineStorage.js    # 离线暂存队列与弱网断点续传
    ├── deviationDetector.js # Turf.js 偏航判断与防抖动引擎
    ├── simulator.js         # 行车仿真控制器 (正常巡航 / 偏航下道 / 隧道断网)
    ├── realRouteData.js     # 百度 BD-09 坐标格式高精路网数据与预设路线
    └── sampleRoutesAB.js    # 同一起终点多方案规划数据 (方案1、2、3)
```

---

## 🚀 快速启动与使用

### 1. 直接打开
直接在浏览器中双击或访问：
`truck-route-deviation-demo/baiduMap/index.html`

### 2. 本地 HTTP 服务打开 (推荐)
```bash
npx serve baiduMap/
# 或在根目录启动任何静态服务器访问 http://localhost:3000/baiduMap/index.html
```

### 3. 操作指引
1. **启动 3D 导航**：点击界面中央的“🚀 进入 3D 沉浸式货运导航”，体验 3D 车头朝上跟随。
2. **测试偏航告警**：点击左侧面板“🎮 虚拟仿真演练控制台”中的“⚠️ 模拟擅自下道偏航”，观察 HUD 红色警报条与警报声音。
3. **测试隧道断网**：点击“🚇 模拟进隧道断网”，观察弱网本地暂存队列计数增长，出隧道后自动清空补传。
4. **更换路线**：点击“🔄 更换路线 / 自定义算路”，选择不同干线方案或输入自定义起终点。
5. **更换百度 AK**：如需使用自己的百度开放平台 AK，可在左侧面板“百度地图 API Key (AK)”输入框中直接修改。
