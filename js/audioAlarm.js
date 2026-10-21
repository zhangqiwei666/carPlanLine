/**
 * 车载智能声音告警模块 (基于 Web Audio API 纯代码合成警报，零外部文件依赖)
 */
class AudioAlarmEngine {
  constructor() {
    this.audioCtx = null;
    this.isMuted = false;
    this.isPlaying = false;
    this.alarmTimer = null;
  }

  init() {
    if (!this.audioCtx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioContext();
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
  }

  /**
   * 触发双频急促偏航警报 (模拟车载电子眼及偏航紧急提示音)
   */
  startDeviationAlarm() {
    this.init();
    if (this.isMuted || this.isPlaying) return;

    this.isPlaying = true;
    let count = 0;

    const playBeep = () => {
      if (!this.isPlaying) return;
      
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();

      // 双频交替：880Hz 与 587Hz (经典工业级紧急预警频率)
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(count % 2 === 0 ? 880 : 587, this.audioCtx.currentTime);

      gain.gain.setValueAtTime(0.2, this.audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, this.audioCtx.currentTime + 0.25);

      osc.connect(gain);
      gain.connect(this.audioCtx.destination);

      osc.start();
      osc.stop(this.audioCtx.currentTime + 0.25);

      count++;
      if (count >= 6) {
        // 播报6声后短暂停顿
        this.stopAlarm();
      } else {
        this.alarmTimer = setTimeout(playBeep, 320);
      }
    };

    playBeep();
  }

  stopAlarm() {
    this.isPlaying = false;
    if (this.alarmTimer) {
      clearTimeout(this.alarmTimer);
      this.alarmTimer = null;
    }
  }

  /**
   * 语音播报（基于浏览器原生 SpeechSynthesis，模拟专业导航语音包）
   */
  speak(text) {
    if (this.isMuted) return;
    try {
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel(); // 停止上一句
        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = 'zh-CN';
        utter.rate = 1.05;
        utter.pitch = 1.0;
        window.speechSynthesis.speak(utter);
      }
    } catch (e) {
      console.warn('语音播报异常:', e);
    }
  }

  toggleMute() {
    this.isMuted = !this.isMuted;
    if (this.isMuted) {
      this.stopAlarm();
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    }
    return this.isMuted;
  }
}

window.audioAlarm = new AudioAlarmEngine();
