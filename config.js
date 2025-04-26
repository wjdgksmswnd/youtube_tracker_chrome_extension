// config.js - 환경 설정 파일
const CONFIG = {
    // 개발 모드 설정 (true: 개발, false: 프로덕션)
    DEV_MODE: true,
    
    // API 서버 URL
    get SERVER_URL() {
      return this.DEV_MODE ? 'http://localhost:8080' : 'https://odo.ist';
    },
    
    // 앱 버전
    VERSION: '2.0.0',
    
    // 디버그 모드 (로깅 수준 설정)
    DEBUG: true
  };
  
  // 스토리지에서 개발 모드 설정 로드
  chrome.storage.local.get(['dev_mode'], function(result) {
    if (result.dev_mode !== undefined) {
      CONFIG.DEV_MODE = result.dev_mode;
      console.log("[ODO] 환경 설정 로드:", CONFIG.DEV_MODE ? "개발" : "프로덕션");
      console.log("[ODO] 서버 URL:", CONFIG.SERVER_URL);
    }
  });