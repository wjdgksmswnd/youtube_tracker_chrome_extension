// content.js - YouTube Music 페이지에서 실행되는 콘텐츠 스크립트
// 전역 상태 변수
let isPlaying = false;
let currentTrack = null;
let playbackStartTime = null;
let pausedTrackInfo = null;
let totalPlaybackTime = 0;
let lastProcessedTrack = null;
let processingTrack = false;
let clientId = null;
let sessionId = null;
let debugMode = true;
let lastStateChangeTime = Date.now();
let retryAttempts = {};
let periodicUpdateTimer = null;
let trackPositionMonitorTimer = null;
let currentTrackPosition = 0;
let lastUpdateSentTime = 0;
let trackHistory = [];
let serverTrackCheckPending = false;

// 서버 URL 가져오기 (config.js에서 설정)
const SERVER_URL = CONFIG.SERVER_URL;

// 디버그 로그 함수
function log(...args) {
  if (debugMode || CONFIG.DEBUG) {
    console.log('[ODO]', ...args);
  }
}

// 상태 완전 초기화 함수
function resetAllState() {
  if (isPlaying) {
    // 재생 중인 경우 종료 이벤트 전송
    if (currentTrack) {
      sendTrackEvent('close', currentTrack);
    }
  }
  
  isPlaying = false;
  currentTrack = null;
  playbackStartTime = null;
  pausedTrackInfo = null;
  totalPlaybackTime = 0;
  lastProcessedTrack = null;
  processingTrack = false;
  lastStateChangeTime = Date.now();
  currentTrackPosition = 0;
  
  // 타이머 정리
  clearPeriodicTimers();
  
  log('모든 상태 변수가 리셋되었습니다');
}

// 초기화 함수
function initialize() {
  log('ODO 트래커 초기화 시작...');
  
  // 클라이언트 ID 초기화
  chrome.storage.local.get(['debugMode', 'token'], function(result) {
    // 디버그 모드 설정
    debugMode = result.debugMode !== false;
    log('디버그 모드:', debugMode);
    
    // 인증 토큰 확인
    if (result.token) {
      log('인증 토큰 확인됨');
      
      // 세션 ID 확인
      if (result.sessionId) {
        sessionId = result.sessionId;
        log('세션 ID 로드:', sessionId);
      } else {
        // 세션 ID가 없으면 새로 생성 요청
        createNewSession(result.token);
      }
    } else {
      log('인증 토큰 없음. 로그인 필요');
    }
    
    // 기록 로드
    loadHistoryFromStorage();
    
    // 페이지가 YouTube Music인지 확인
    if (isYouTubeMusic()) {
      log('YouTube Music 페이지 감지됨');
      
      // DOM 이미 로드되었는지 확인
      if (document.readyState === 'complete') {
        setupTracking();
      } else {
        // DOM이 완전히 로드될 때까지 대기
        window.addEventListener('load', setupTracking);
      }
    } else {
      log('YouTube Music 페이지가 아닙니다. 트래킹을 시작하지 않습니다.');
    }
  });
  
  // 페이지 언로드 이벤트 리스너
  window.addEventListener('beforeunload', function(event) {
    // 재생 중인 경우 종료 이벤트 전송
    if (isPlaying && currentTrack) {
      sendTrackEvent('close', currentTrack);
    }
  });
  
  // 브라우저 세션 종료 시 이벤트 전송
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'hidden' && isPlaying && currentTrack) {
      // 현재 상태 업데이트를 보냄 (종료는 아님)
      sendTrackEvent('update', currentTrack);
    }
  });
  
  // 1시간마다 한 번씩 상태 리셋 (재생 중이 아닐 때만)
  setInterval(function() {
    if (!isPlaying) {
      log('정기 상태 리셋 수행');
      resetAllState();
    }
  }, 60 * 60 * 1000);
}

// 새 세션 생성 함수
async function createNewSession(token) {
  try {
    // 기기 정보 수집
    const deviceInfo = {
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language
    };
    
    const response = await fetch(`${SERVER_URL}/api/extention/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ device_info: deviceInfo })
    });
    
    const data = await response.json();
    
    if (response.ok) {
      sessionId = data.sessionId;
      chrome.storage.local.set({ sessionId });
      log('새 세션 생성 성공:', sessionId);
    } else {
      log('세션 생성 실패:', data.error);
    }
  } catch (err) {
    console.error('[ODO] 세션 생성 오류:', err);
  }
}

// 트래킹 설정
function setupTracking() {
  log('트래킹 설정 시작...');
  
  // 현재 DOM 상태 로깅 (디버깅용)
  logDOMElements();
  
  // YouTube Music의 DOM이 제대로 로드되었는지 확인
  const observer = new MutationObserver(function(mutations, observer) {
    // 플레이어 바 또는 동영상 요소가 있는지 확인
    if (document.querySelector('ytmusic-player-bar') || 
        document.querySelector('.ytmusic-player-bar') || 
        document.querySelector('video')) {
      observer.disconnect();
      log('YouTube Music 플레이어 감지됨, 트래킹 시작');
      
      // DOM 요소 다시 로깅
      logDOMElements();
      
      // DOM 변경 감지 설정
      setupMutationObserver();
      
      // 첫 상태 확인
      setTimeout(checkCurrentState, 1000);
      
      // 정기 체크 설정
      setInterval(checkCurrentState, 10000); // 10초마다 확인
      
      // 서버에서 승인된 트랙 여부 확인
      checkTrackInPlaylists();
    }
  });
  
  // body 요소 관찰 시작
  observer.observe(document.body, { childList: true, subtree: true });
  
  // 서버 연결 테스트
  testServerConnection();
}

// 현재 DOM 구조 로깅
function logDOMElements() {
  log('현재 DOM 구조 스캔 중...');
  
  // 1. 플레이어 바 확인
  const playerBar = document.querySelector('ytmusic-player-bar');
  log('플레이어 바 요소:', playerBar ? 'O' : 'X');
  
  // 2. 제목 관련 요소 검색
  const titleElements = [
    document.querySelector('.title.ytmusic-player-bar'),
    document.querySelector('yt-formatted-string.title'),
    document.querySelector('.content-info-wrapper .title'),
    document.querySelector('.title')
  ];
  
  log('제목 요소 찾기 결과:', titleElements.map(el => el ? el.textContent.trim() : null));
  
  // 3. 아티스트 관련 요소 검색
  const artistElements = [
    document.querySelector('.subtitle.ytmusic-player-bar'),
    document.querySelector('yt-formatted-string.subtitle'),
    document.querySelector('.content-info-wrapper .subtitle'),
    document.querySelector('.subtitle')
  ];
  
  log('아티스트 요소 찾기 결과:', artistElements.map(el => el ? el.textContent.trim() : null));
  
  // 4. 페이지 제목 확인
  log('현재 페이지 제목:', document.title);
  
  // 5. 미디어 세션 확인
  log('미디어 세션 사용 가능:', navigator.mediaSession ? 'O' : 'X');
  if (navigator.mediaSession && navigator.mediaSession.metadata) {
    log('미디어 세션 메타데이터:', {
      title: navigator.mediaSession.metadata.title,
      artist: navigator.mediaSession.metadata.artist
    });
  }
  
  // 6. 재생 버튼 확인
  const playButton = document.querySelector('tp-yt-paper-icon-button.play-pause-button, .play-pause-button');
  log('재생 버튼:', playButton ? `O (타이틀: ${playButton.getAttribute('title') || '없음'})` : 'X');
  
  // 7. 비디오 요소 확인
  const video = document.querySelector('video');
  log('비디오 요소:', video ? `O (재생 중: ${!video.paused})` : 'X');
  
  // 8. URL 분석
  log('현재 URL:', window.location.href);
  const videoParam = new URLSearchParams(window.location.search).get('v');
  log('URL 비디오 ID:', videoParam || '없음');
}

// 서버 연결 테스트
async function testServerConnection() {
  log('서버 연결 테스트 중...');
  
  try {
    const response = await fetch(`${SERVER_URL}/api`);
    
    if (!response.ok) {
      throw new Error(`서버 응답 오류: ${response.status}`);
    }
    
    const data = await response.json();
    log('서버 연결 성공:', data);
  } catch (error) {
    console.error('[ODO] 서버 연결 실패:', error);
    log('서버 연결에 실패했습니다. 서버가 실행 중인지 확인하세요.');
  }
}

// YouTube Music 페이지인지 확인
function isYouTubeMusic() {
  return window.location.hostname === 'music.youtube.com';
}

// UUID 생성 함수
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// 로컬 스토리지에서 기록 로드
function loadHistoryFromStorage() {
  chrome.storage.local.get(['history'], function(data) {
    trackHistory = data.history || [];
    log(`${trackHistory.length}개의 트랙 기록 로드됨`);
    
    // 최근 트랙 카운트를 확장 아이콘 배지에 표시
    const todayTracks = countTodayTracks();
    chrome.runtime.sendMessage({
      action: 'updateEarnings',
      count: todayTracks
    });
  });
}

// 오늘 재생한 트랙 수 카운트
function countTodayTracks() {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  return trackHistory.filter(track => 
    track.startTime && track.startTime.startsWith(today)
  ).length;
}

// DOM 변경 감지를 위한 MutationObserver 설정
function setupMutationObserver() {
  const observer = new MutationObserver(function(mutations) {
    let shouldCheckState = false;
    
    for (const mutation of mutations) {
      // 페이지 제목 변경 감지 (가장 확실한 방법)
      if (mutation.target.nodeName === 'TITLE') {
        log('페이지 타이틀 변경 감지:', document.title);
        shouldCheckState = true;
        break;
      }
      
      // 플레이어 요소 변경 감지
      if (mutation.target.nodeName === 'YTMUSIC-PLAYER-BAR' ||
          mutation.target.classList && 
          (mutation.target.classList.contains('title') || 
           mutation.target.classList.contains('subtitle'))) {
        log('플레이어 요소 변경 감지');
        shouldCheckState = true;
        break;
      }
      
      // 재생 상태 변경 감지
      if ((mutation.type === 'attributes' && 
          (mutation.attributeName === 'title' || mutation.attributeName === 'class') &&
          mutation.target.classList && 
          mutation.target.classList.contains('play-pause-button')) || 
          (mutation.target.nodeName === 'VIDEO')) {
        log('재생 상태 변경 감지');
        shouldCheckState = true;
        break;
      }
      
      // 진행 바 변경 감지 (사용자가 seek 버튼 사용)
      if (mutation.target.classList && 
          (mutation.target.classList.contains('time-info') || 
           mutation.target.classList.contains('progress-bar'))) {
        const video = document.querySelector('video');
        if (video && currentTrack) {
          const newPosition = Math.floor(video.currentTime);
          if (Math.abs(newPosition - currentTrackPosition) > 3) {
            log('진행 바 변경 감지 (seek):', currentTrackPosition, '->', newPosition);
            currentTrackPosition = newPosition;
            sendTrackEvent('seek', currentTrack);
          }
        }
      }
    }
    
    if (shouldCheckState && !processingTrack) {
      lastStateChangeTime = Date.now();
      
      // 트랙 변경 감지 시 디바운싱 적용 (중복 호출 방지)
      clearTimeout(window.trackChangeDebounceTimer);
      
      // 즉시 한 번 확인 후
      window.trackChangeDebounceTimer = setTimeout(() => {
        log('트랙 변경 감지, 즉시 상태 확인');
        checkCurrentState();
        
        // 약간의 지연 후 다시 확인 (DOM 업데이트 반영을 위해)
        setTimeout(() => {
          log('트랙 변경 후 지연 상태 확인 (1.5초 후)');
          checkCurrentState();
          
          // 한 번 더 지연 확인 (3초 후)
          setTimeout(() => {
            log('트랙 변경 후 지연 상태 확인 (3초 후)');
            checkCurrentState();
          }, 3000);
        }, 1500);
      }, 500);
    }
  });
  
  // 문서 전체와 타이틀 요소 관찰
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['title', 'aria-label', 'src', 'class', 'paused']
  });
  
  // 타이틀 요소도 별도로 관찰
  const titleElement = document.querySelector('title');
  if (titleElement) {
    observer.observe(titleElement, { childList: true, characterData: true });
  }
  
  log('DOM 변경 감지 설정 완료');
  
  // 비디오 시간 업데이트 이벤트 추가
  const video = document.querySelector('video');
  if (video) {
    video.addEventListener('timeupdate', handleTimeUpdate);
  }
}

// 비디오 timeupdate 이벤트 핸들러
function handleTimeUpdate(e) {
  if (!isPlaying || !currentTrack) return;
  
  const video = e.target;
  const newPosition = Math.floor(video.currentTime);
  
  // 현재 재생 위치 저장
  currentTrackPosition = newPosition;
}

// 주기적인 타이머 정리
function clearPeriodicTimers() {
  if (periodicUpdateTimer) {
    clearInterval(periodicUpdateTimer);
    periodicUpdateTimer = null;
  }
  
  if (trackPositionMonitorTimer) {
    clearInterval(trackPositionMonitorTimer);
    trackPositionMonitorTimer = null;
  }
}

// 주기적인 업데이트 시작
function startPeriodicUpdates(track) {
  // 기존 타이머 정리
  clearPeriodicTimers();
  
  // 10초마다 현재 상태 서버에 전송
  periodicUpdateTimer = setInterval(() => {
    if (isPlaying && currentTrack) {
      // 마지막 업데이트 후 시간이 3초 이상 지났으면 업데이트 전송
      if (Date.now() - lastUpdateSentTime > 3000) {
        sendTrackEvent('update', currentTrack);
        lastUpdateSentTime = Date.now();
      }
    }
  }, 10000);
  
  // 현재 재생 위치 모니터링
  trackPositionMonitorTimer = setInterval(() => {
    if (isPlaying && currentTrack) {
      const video = document.querySelector('video');
      if (video) {
        const newPosition = Math.floor(video.currentTime);
        if (Math.abs(newPosition - currentTrackPosition) > 5) {
          // 5초 이상 점프 시 seek 이벤트 발생
          log('재생 위치 5초 이상 점프 감지 (seek):', currentTrackPosition, '->', newPosition);
          currentTrackPosition = newPosition;
          sendTrackEvent('seek', currentTrack);
        } else {
          currentTrackPosition = newPosition;
        }
      }
    }
  }, 1000);
}

// 현재 재생 상태 확인
function checkCurrentState() {
  if (processingTrack) {
    log('이미 처리 중, 건너뜀');
    return;
  }
  
  try {
    processingTrack = true;
    log('현재 재생 상태 확인 중...');
    
    // 일정 시간 동안 상태 변화가 없으면 강제 체크
    const currentTime = Date.now();
    if (lastStateChangeTime && (currentTime - lastStateChangeTime > 5 * 60 * 1000)) {
      log('5분 이상 상태 변화 없음, 강제 체크');
      isPlaying = false; // 재생 상태 강제 리셋
      lastStateChangeTime = currentTime;
    }

    // 1. 현재 재생 상태 확인 (여러 방법으로 시도)
    let isCurrentlyPlaying = false;
    
    // 방법 1: 메인 재생 버튼 확인
    const playButton = document.querySelector('tp-yt-paper-icon-button.play-pause-button, .play-pause-button');
    if (playButton) {
      const title = playButton.getAttribute('title') || '';
      // 일시정지 버튼이면 재생 중
      isCurrentlyPlaying = /pause|일시중지|일시 중지|정지/.test(title.toLowerCase());
      log('재생 버튼 타이틀:', title, '재생 중:', isCurrentlyPlaying);
    }
    
    // 방법 2: 비디오 요소 확인 (재생 버튼이 없는 경우)
    if (!playButton) {
      const video = document.querySelector('video');
      if (video) {
        isCurrentlyPlaying = video && !video.paused;
        log('비디오 요소로 재생 상태 확인:', isCurrentlyPlaying);
      }
    }
    
    // 2. 트랙 정보 확인
    const trackInfo = extractTrackInfo();
    if (!trackInfo.title) {
      log('유효한 트랙 정보를 찾을 수 없음, 건너뜀');
      processingTrack = false;
      return;
    }
    
    const { title, artist, youtube_track_id, youtube_playlist_id } = trackInfo;
    log('감지된 트랙 정보:', { title, artist, youtube_track_id, youtube_playlist_id });
    
    // 3. 트랙 식별자 생성 - 제목과 아티스트 조합
    const trackIdentifier = `${title}-${artist}`;
    
    // 4. 트랙 상태 처리
    
    // 일시정지 상태에서 재생으로 전환된 경우 (동일한 트랙)
    if (!isPlaying && isCurrentlyPlaying && pausedTrackInfo) {
      const pausedTrackName = `${pausedTrackInfo.trackData.title}-${pausedTrackInfo.trackData.artist}`;
      if (pausedTrackName === trackIdentifier) {
        log('일시정지에서 재생으로 전환 (동일 트랙):', pausedTrackInfo.title);
        
        // 이전 트랙 정보 복원
        isPlaying = true;
        currentTrack = pausedTrackInfo.trackData;
        
        // 새로운 재생 시작 시간 설정 (이전의 재생 시간 고려)
        const currentTime = Date.now();
        playbackStartTime = currentTime - pausedTrackInfo.totalPlaybackTime;
        
        log('트랙 재생 재개:', {
          title: currentTrack.title,
          playbackStartTime,
          totalPlaybackTime: pausedTrackInfo.totalPlaybackTime
        });
        
        // resume 이벤트 전송
        sendTrackEvent('resume', currentTrack);
        
        // 주기적 업데이트 시작
        startPeriodicUpdates(currentTrack);
        
        // 상태 변경 시간 업데이트
        lastStateChangeTime = Date.now();
        processingTrack = false;
        return;
      }
    }
    
    // 일시정지로 전환된 경우 (기존에 재생 중이었던 트랙)
    if (isPlaying && !isCurrentlyPlaying && currentTrack) {
      log('재생에서 일시정지로 전환:', currentTrack.title);
      
      // 현재까지 재생된 시간 계산 및 누적
      const currentPlaybackTime = playbackStartTime ? Date.now() - playbackStartTime : 0;
      totalPlaybackTime += currentPlaybackTime;
      
      // 일시정지된 트랙 정보 저장
      pausedTrackInfo = {
        trackIdentifier,
        trackData: currentTrack,
        totalPlaybackTime: totalPlaybackTime,
        pausedAt: new Date().toISOString(),
        title: currentTrack.title
      };
      
      isPlaying = false;
      
      log('일시정지 정보 저장:', {
        title: pausedTrackInfo.title,
        totalPlaybackTime: pausedTrackInfo.totalPlaybackTime
      });
      
      // pause 이벤트 전송
      sendTrackEvent('pause', currentTrack);
      
      // 주기적 업데이트 중지
      clearPeriodicTimers();
      
      // 일시 정지되었으므로 playbackStartTime을 null로 설정하지만
      // currentTrack은 그대로 유지하여 트랙 정보가 유지되도록 함
      playbackStartTime = null;
      
      // 상태 변경 시간 업데이트
      lastStateChangeTime = Date.now();
      processingTrack = false;
      return;
    }
    
    // 이미 처리한 트랙이고 상태 변경이 없는 경우 (곡 제목 기준으로 비교)
    if (lastProcessedTrack === trackIdentifier && isCurrentlyPlaying === isPlaying) {
      log('이미 처리한 트랙, 상태 변경 없음 (계속 재생 중) - 건너뜀');
      processingTrack = false;
      return;
    }
    
    // 실제 트랙 변경 감지
    const isRealTrackChange = lastProcessedTrack && 
                           trackIdentifier !== lastProcessedTrack && 
                           isCurrentlyPlaying;
    
    // 기존 트랙 처리 - 실제 트랙 변경이거나 재생 중지될 때만
    if (currentTrack && isPlaying && (isRealTrackChange || !isCurrentlyPlaying)) {
      log('트랙 변경 또는 재생 중지로 기존 트랙 완료 처리');
      finishCurrentTrack(isRealTrackChange ? 'skip' : 'finish');
    }
    
    // 새 트랙 시작 - 처음 재생되거나 트랙이 변경될 때만
    if (isCurrentlyPlaying && 
        (!currentTrack || isRealTrackChange || !lastProcessedTrack)) {
      // 이전 일시정지 정보 초기화 (새 트랙이므로)
      pausedTrackInfo = null;
      totalPlaybackTime = 0; // 새 트랙이므로 누적 시간 초기화
      
      log('새 트랙 시작 또는 트랙 변경 감지');
      startPlayback(title, artist, youtube_track_id, youtube_playlist_id);
      
      // 트랙 인식할 때 서버 확인 진행
      if (!serverTrackCheckPending) {
        checkTrackInPlaylists(youtube_track_id);
      }
    } else if (!isCurrentlyPlaying && currentTrack) {
      // 재생이 중지되고 이미 트랙이 있는 경우 일시 정지 상태로 유지
      isPlaying = false;
      
      // 상태 변경 시간 업데이트
      lastStateChangeTime = Date.now();
    }
    
    // 마지막 처리한 트랙 업데이트
    lastProcessedTrack = trackIdentifier;
    
    // 아티스트가 '알 수 없는 아티스트'일 경우 재시도 수 추적
    if ((artist === '알 수 없는 아티스트' || !artist) && youtube_track_id) {
      if (!retryAttempts[youtube_track_id]) {
        retryAttempts[youtube_track_id] = 0;
      }
      retryAttempts[youtube_track_id]++;
      
      // 최대 5회까지만 재시도 (리소스 낭비 방지)
      if (retryAttempts[youtube_track_id] <= 5) {
        log(`아티스트 정보 누락, ${retryAttempts[youtube_track_id]}번째 재시도 예약 (youtube_track_id: ${youtube_track_id})`);
        // 2초 후 다시 확인 시도
        setTimeout(() => {
          log(`${youtube_track_id} 아티스트 정보 추출 재시도`);
          const newInfo = extractTrackInfo();
          if (newInfo.artist && newInfo.artist !== '알 수 없는 아티스트' && currentTrack) {
            log(`아티스트 정보 재시도 성공: ${newInfo.artist}`);
            currentTrack.artist = newInfo.artist;
            // lastProcessedTrack도 업데이트 (제목-아티스트 형식)
            lastProcessedTrack = `${currentTrack.title}-${newInfo.artist}`;
          }
        }, 2000);
      }
    } else if (youtube_track_id) {
      // 아티스트 정보가 있으면 재시도 카운터 리셋
      retryAttempts[youtube_track_id] = 0;
    }
    
  } catch (error) {
    console.error('[ODO] 재생 상태 확인 오류:', error);
  } finally {
    processingTrack = false;
  }
}

// 트랙 정보 추출 함수
function extractTrackInfo() {
  let title = '';
  let artist = '';
  let youtube_track_id = '';
  let youtube_playlist_id = '';
  let successMethod = '';
  
  // 우선: 미디어 세션 API 확인 (가장 신뢰할 수 있음)
  if (navigator.mediaSession && navigator.mediaSession.metadata) {
    try {
      const metadata = navigator.mediaSession.metadata;
      if (metadata && metadata.title) {
        title = metadata.title;
        artist = metadata.artist || '';
        log('미디어 세션에서 트랙 정보 추출 성공:', {title, artist});
        successMethod = 'mediaSession';
      }
    } catch (e) {
      log('미디어 세션 접근 실패:', e);
    }
  }
  
  // 다음: 페이지 제목에서 추출
  if (!artist && document.title && document.title.includes(' - ')) {
    try {
      const parts = document.title.split(' - ');
      if (parts.length >= 2) {
        // YouTube Music 패턴: "곡 제목 - 아티스트 - YouTube Music"
        if (!title) title = parts[0].trim();
        
        // 마지막 부분이 "YouTube Music"이면 아티스트는 중간 부분
        if (parts[parts.length - 1].includes('YouTube Music') && parts.length >= 3) {
          artist = parts[1].trim();
        } 
        // 아니면 두 번째 부분이 아티스트
        else if (parts.length >= 2) {
          artist = parts[1].trim();
        }
        
        if (title && artist) {
          log('페이지 제목에서 트랙 정보 추출 성공:', {title, artist});
          successMethod = 'pageTitle';
        }
      }
    } catch (e) {
      log('페이지 제목 파싱 실패:', e);
    }
  }
  
  // 직접 DOM 요소 확인 (여러 가능한 선택자)
  if (!artist) {
    try {
      // 직접 다양한 선택자를 시도
      const possibleTitleSelectors = [
        '.title.ytmusic-player-bar',
        'yt-formatted-string.title',
        '.content-info-wrapper .title',
        'ytmusic-player-bar .title',
        'span.title',
        '.metadata .title'
      ];
      
      const possibleArtistSelectors = [
        '.subtitle.ytmusic-player-bar',
        'yt-formatted-string.subtitle',
        '.content-info-wrapper .subtitle',
        'ytmusic-player-bar .subtitle',
        'span.subtitle',
        '.metadata .subtitle'
      ];
      
      // 제목 추출 (이미 다른 방법으로 제목이 있으면 유지)
      if (!title) {
        for (const selector of possibleTitleSelectors) {
          const element = document.querySelector(selector);
          if (element && element.textContent.trim()) {
            title = element.textContent.trim();
            break;
          }
        }
      }
      
      // 아티스트 추출
      for (const selector of possibleArtistSelectors) {
        const element = document.querySelector(selector);
        if (element && element.textContent.trim()) {
          const text = element.textContent.trim();
          // 아티스트 정보에는 종종 '•' 문자로 구분된 추가 정보가 있음
          artist = text.split('•')[0].trim();
          break;
        }
      }
      
      if (artist) {
        log('DOM 선택자로 아티스트 정보 추출 성공:', {title, artist});
        successMethod = 'domSelectors';
      }
    } catch (e) {
      log('DOM 요소 접근 실패:', e);
    }
  }
  
  // YouTube ID 추출
  youtube_track_id = getVideoId();
  
  // 플레이리스트 ID 추출
  youtube_playlist_id = getPlaylistId();
  
  // 로그 기록
  if (artist) {
    log('트랙 정보 추출 성공 (방법: ' + successMethod + '):', {title, artist, youtube_track_id, youtube_playlist_id});
  } else {
    // 모든 방법 실패하여 아티스트 정보를 찾지 못함
    log('아티스트 정보 추출 실패. 현재 페이지 상태:', {
      title: document.title,
      url: location.href,
      playerBar: !!document.querySelector('ytmusic-player-bar'),
      video: !!document.querySelector('video')
    });
  }
  
  // 기본값 제공 (필요한 경우)
  return {
    title: title || '알 수 없는 트랙',
    artist: artist || '알 수 없는 아티스트',
    youtube_track_id: youtube_track_id || `unknown-${Date.now().toString(36)}`,
    youtube_playlist_id: youtube_playlist_id || null
  };
}

// YouTube 트랙 ID 추출 함수
function getVideoId() {
  try {
    // URL에서 비디오 ID 추출
    const urlMatch = location.href.match(/[?&]v=([^&]+)/);
    if (urlMatch && urlMatch[1]) {
      return urlMatch[1];
    }
    
    // 미디어 세션에서 소스 URL 확인
    const video = document.querySelector('video');
    if (video && video.src) {
      const srcMatch = video.src.match(/\/([a-zA-Z0-9_-]{11})\//);
      if (srcMatch && srcMatch[1]) {
        return srcMatch[1];
      }
    }
    
    // 플레이어 요소 데이터 확인
    const playerBar = document.querySelector('ytmusic-player-bar');
    if (playerBar && playerBar.getAttribute('data-current-video')) {
      try {
        const data = JSON.parse(playerBar.getAttribute('data-current-video'));
        if (data && data.videoId) {
          return data.videoId;
        }
      } catch (e) {
        console.error('데이터 파싱 오류:', e);
      }
    }
    
    // URL 매개변수에서 찾기
    const videoParam = new URLSearchParams(window.location.search).get('v');
    if (videoParam) {
      return videoParam;
    }
    
    // 여기서부터 개선된 로직:
    // 현재 곡 정보(제목+아티스트)를 기반으로 안정적인 ID 생성
    if (navigator.mediaSession && navigator.mediaSession.metadata) {
      const metadata = navigator.mediaSession.metadata;
      if (metadata && metadata.title && metadata.artist) {
        // 제목과 아티스트로 해시 생성
        const songInfo = `${metadata.title}-${metadata.artist}`;
        const hash = hashString(songInfo);
        return `song-${hash}`;
      }
    }
    
    // 페이지 제목에서도 시도
    if (document.title && document.title.includes(' - ')) {
      const hash = hashString(document.title);
      return `title-${hash}`;
    }
    
    // 최후의 방법: 현재 시간 + 랜덤 문자열
    // 이제 함수 실행할 때마다 다른 ID가 생성되지 않도록 현재 시간을 분 단위로 반올림
    const now = new Date();
    const roundedMinutes = Math.floor(now.getTime() / (60 * 1000)); // 분 단위로 반올림
    return `temp-${roundedMinutes.toString(36)}`;
  } catch (error) {
    console.error('비디오 ID 추출 오류:', error);
    return 'error-' + Date.now().toString(36);
  }
}

// 플레이리스트 ID 추출 함수
function getPlaylistId() {
  try {
    // URL에서 플레이리스트 ID 추출
    const urlMatch = location.href.match(/[?&]list=([^&]+)/);
    if (urlMatch && urlMatch[1]) {
      return urlMatch[1];
    }
    
    // URL 매개변수에서 찾기
    const listParam = new URLSearchParams(window.location.search).get('list');
    if (listParam) {
      return listParam;
    }
    
    // DOM에서 플레이리스트 정보 찾기
    const playlistLink = document.querySelector('a[href*="list="]');
    if (playlistLink) {
      const hrefMatch = playlistLink.href.match(/[?&]list=([^&]+)/);
      if (hrefMatch && hrefMatch[1]) {
        return hrefMatch[1];
      }
    }
    
    return null;
  } catch (error) {
    console.error('플레이리스트 ID 추출 오류:', error);
    return null;
  }
}

// 문자열에서 간단한 해시 생성
function hashString(str) {
  let hash = 0;
  if (str.length === 0) return hash.toString(36);
  
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // 32비트 정수로 변환
  }
  
  return Math.abs(hash).toString(36);
}

// 재생 시작
function startPlayback(title, artist, youtube_track_id, youtube_playlist_id) {
  log(`재생 시작: ${title} - ${artist} (${youtube_track_id})`);
  
  isPlaying = true;
  playbackStartTime = Date.now();
  
  currentTrack = {
    youtube_track_id,
    title,
    artist,
    youtube_playlist_id,
    startTime: new Date().toISOString(),
    url: window.location.href
  };
  
  // 비디오 요소에서 총 재생 시간 가져오기
  const video = document.querySelector('video');
  if (video) {
    currentTrack.duration = Math.floor(video.duration);
    currentTrackPosition = Math.floor(video.currentTime);
  }
  
  // 재생 시작 이벤트 전송
  sendTrackEvent('start', currentTrack);
  
  // 주기적 업데이트 시작
  startPeriodicUpdates(currentTrack);
}

// 현재 트랙 완료 처리
function finishCurrentTrack(eventType = 'finish') {
  if (!currentTrack || !playbackStartTime) {
    return;
  }
  
  // 주기적 업데이트 중단
  clearPeriodicTimers();
  
  // 비디오 요소에서 재생 시간 및 위치 가져오기
  const video = document.querySelector('video');
  let actualDuration = 0;
  let isComplete = false;
  
  if (video) {
    actualDuration = Math.floor(Date.now() - playbackStartTime) / 1000;
    const totalDuration = video.duration;
    currentTrackPosition = Math.floor(video.currentTime);
    
    // 완료 여부 판단 (총 재생 시간의 90% 이상 재생했거나, 끝에서 10초 이내인 경우)
    isComplete = (currentTrackPosition / totalDuration > 0.9) || 
                 (totalDuration - currentTrackPosition < 10);
  } else {
    actualDuration = Math.floor((Date.now() - playbackStartTime) / 1000);
  }
  
  // 최소 재생 시간을 3초로 설정
  if (actualDuration >= 3) {
    const record = {
      ...currentTrack,
      duration: currentTrack.duration || 0,
      actualDuration,
      endTime: new Date().toISOString(),
      isComplete
    };
    
    log(`트랙 종료: ${record.title} - ${record.artist}, 재생 시간: ${actualDuration}초, 완료: ${isComplete}`);
    
    // 중복 체크 (시간 제한 제거)
    const isDuplicate = checkDuplicate(record);
    
    if (!isDuplicate) {
      // 종료 이벤트 전송
      sendTrackEvent(eventType, record);
      
      // 서버로 청취 기록 전송
      sendListeningData(record);
      
      // 기록에 추가
      trackHistory.push(record);
      chrome.storage.local.set({ history: trackHistory.slice(-1000) }); // 최근 1000개만 저장
      log('트랙 기록 저장됨');
      
      // 최근 트랙 수 업데이트
      const todayTracks = countTodayTracks();
      chrome.runtime.sendMessage({
        action: 'updateEarnings',
        count: todayTracks
      });
    }
  } else {
    log(`재생 시간이 너무 짧음 (${actualDuration}초), 기록하지 않음`);
  }
  
  // 재생 상태 초기화
  isPlaying = false;
  playbackStartTime = null;
  currentTrack = null;
  pausedTrackInfo = null;
  totalPlaybackTime = 0;
}

// 중복 체크
function checkDuplicate(record) {
  // 히스토리가 비어있으면 중복이 아님
  if (trackHistory.length === 0) {
    return false;
  }
  
  // 직전 트랙과 정확히 동일한 record_id인 경우만 중복으로 처리
  const lastTrack = trackHistory[trackHistory.length - 1];
  
  // 완전히 동일한 startTime을 가진 경우만 중복으로 처리
  if (lastTrack.youtube_track_id === record.youtube_track_id && 
      lastTrack.startTime === record.startTime) {
    log('중복 트랙 감지: 정확히 동일한 트랙 ID와 시작 시간');
    return true;
  }
  
  // 그 외에는 모두 새로운 트랙으로 처리
  return false;
}

// 인증 정보 가져오기
function getAuthInfo(callback) {
  chrome.storage.local.get(['token', 'sessionId'], function(result) {
    if (result.token) {
      const authInfo = {
        token: result.token,
        sessionId: result.sessionId
      };
      
      callback(authInfo);
    } else {
      log('인증 정보 없음');
      callback(null);
    }
  });
}

// 트랙 이벤트 전송
async function sendTrackEvent(eventType, trackData) {
  // 마지막 이벤트 업데이트 시간 저장
  if (eventType === 'update' || eventType === 'seek') {
    lastUpdateSentTime = Date.now();
  }
  
  try {
    getAuthInfo(async function(authInfo) {
      if (!authInfo) {
        log('인증 정보 없음, 이벤트 전송 생략');
        return;
      }
      
      // 비디오 요소에서 현재 재생 위치 가져오기
      const video = document.querySelector('video');
      const position = video ? Math.floor(video.currentTime) : currentTrackPosition;
      
      // 현재 시간 기준 재생 시간 계산
      let duration = 0;
      if (playbackStartTime && eventType !== 'start') {
        duration = Math.floor((Date.now() - playbackStartTime) / 1000);
      } else if (trackData.duration) {
        duration = trackData.duration;
      } else if (video) {
        duration = Math.floor(video.duration);
      }
      
      // 보낼 데이터 준비
      const eventData = {
        youtube_track_id: trackData.youtube_track_id,
        youtube_playlist_id: trackData.youtube_playlist_id,
        title: trackData.title,
        artist: trackData.artist,
        event_type: eventType,
        track_position_seconds: position,
        duration_seconds: duration,
        player_timestamp: new Date().toISOString(),
        history_id: trackData.history_id,
        url: trackData.url || window.location.href
      };
      
      // Beacon API로 전송 (페이지 닫힘 이벤트인 경우)
      if (eventType === 'close') {
        const blob = new Blob([JSON.stringify(eventData)], { type: 'application/json' });
        navigator.sendBeacon(
          `${SERVER_URL}/api/listening/event`, 
          blob
        );
        log('Beacon API로 종료 이벤트 전송');
        return;
      }
      
      // 일반 요청으로 전송
      const response = await fetch(`${SERVER_URL}/api/listening/event`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authInfo.token}`,
          ...(authInfo.sessionId && { 'X-Session-ID': authInfo.sessionId })
        },
        body: JSON.stringify(eventData)
      });
      
      // 응답 처리
      if (response.ok) {
        log(`${eventType} 이벤트 전송 성공`);
      } else if (response.status === 401) {
        const errorData = await response.json();
        
        // 세션 만료 처리
        if (errorData.error === 'session_expired') {
          log('세션 만료:', errorData.message);
          
          // 세션 ID 제거
          chrome.storage.local.remove(['sessionId']);
          sessionId = null;
          
          // 사용자에게 알림
          showNotification(
            '세션 만료', 
            errorData.message, 
            errorData.ip_conflict ? '다른 창 닫기' : '로그인',
            errorData.ip_conflict ? handleCloseTab : handleLogin
          );
          
          // 종료 이벤트 전송 (세션 만료)
          if (currentTrack) {
            sendTrackEvent('session_expired', currentTrack);
          }
          
          // 상태 리셋
          resetAllState();
        }
      } else {
        log(`이벤트 전송 실패: ${response.status}`);
      }
    });
  } catch (err) {
    console.error('[ODO] 이벤트 전송 오류:', err);
  }
}

// 청취 데이터 전송
async function sendListeningData(trackData) {
  // 최소 재생 시간 미달 시 스킵
  if (trackData.actualDuration < 3) {
    log('재생 시간이 너무 짧아 서버 전송 스킵');
    return;
  }
  
  log('서버로 청취 기록 전송 시도:', trackData);
  
  try {
    getAuthInfo(async function(authInfo) {
      if (!authInfo) {
        log('인증 정보 없음, 보류 중인 트랙으로 저장');
        storePendingTrack(trackData);
        return;
      }
      
      // record_id 생성 (고유성 보장)
      const record_id = `${clientId}-${trackData.youtube_track_id}-${Date.now()}`;
      
      // 서버로 전송
      const response = await fetch(`${SERVER_URL}/api/listening`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authInfo.token}`,
          ...(authInfo.sessionId && { 'X-Session-ID': authInfo.sessionId })
        },
        body: JSON.stringify({
          youtube_id: trackData.youtube_track_id,
          title: trackData.title,
          artist: trackData.artist,
          duration_seconds: trackData.duration || 0,
          play_start_time: trackData.startTime,
          play_end_time: trackData.endTime,
          actual_duration_seconds: trackData.actualDuration,
          is_complete: trackData.isComplete !== false,
          youtube_playlist_id: trackData.youtube_playlist_id,
          client_id: record_id
        })
      });
      
      if (response.ok) {
        const data = await response.json();
        log('청취 기록 전송 성공:', data);
        
        // 새 history_id 저장
        if (data.history_id) {
          trackData.history_id = data.history_id;
        }
      } else if (response.status === 401) {
        const errorData = await response.json();
        
        // 세션 만료 처리
        if (errorData.error === 'session_expired') {
          log('세션 만료:', errorData.message);
          
          // 세션 ID 제거
          chrome.storage.local.remove(['sessionId']);
          sessionId = null;
          
          // 보류 중인 트랙으로 저장
          storePendingTrack(trackData);
          
          // 사용자에게 알림
          showNotification(
            '세션 만료', 
            errorData.message, 
            errorData.ip_conflict ? '다른 창 닫기' : '로그인',
            errorData.ip_conflict ? handleCloseTab : handleLogin
          );
        }
      } else {
        log('청취 기록 전송 실패, 보류 중인 트랙으로 저장');
        storePendingTrack(trackData);
      }
    });
  } catch (err) {
    console.error('[ODO] 서버 통신 오류:', err);
    storePendingTrack(trackData);
  }
}

// 보류 중인 트랙 저장
function storePendingTrack(trackData) {
  const record = {
    ...trackData,
    record_id: `${clientId}-${trackData.youtube_track_id}-${Date.now()}`
  };
  
  chrome.storage.local.get(['pending'], function(result) {
    const pendingTracks = result.pending || [];
    
    // 중복 확인 (정확히 같은 시작 시간의 같은 트랙인 경우만)
    const isDuplicate = pendingTracks.some(track => 
      track.youtube_track_id === record.youtube_track_id && 
      track.startTime === record.startTime
    );
    
    if (!isDuplicate) {
      pendingTracks.push(record);
      chrome.storage.local.set({ pending: pendingTracks });
      log('보류 중인 트랙으로 저장됨');
      
      // 백그라운드에 동기화 요청
      setTimeout(() => {
        chrome.runtime.sendMessage({ action: 'syncPendingTracks' });
      }, 5000);
    } else {
      log('이미 보류 중인 트랙에 존재 (동일 트랙)');
    }
  });
}

// 현재 트랙이 승인된 플레이리스트에 있는지 확인
async function checkTrackInPlaylists(youtube_track_id) {
  if (serverTrackCheckPending) {
    return;
  }
  
  serverTrackCheckPending = true;
  
  try {
    const trackId = youtube_track_id || (currentTrack ? currentTrack.youtube_track_id : null);
    if (!trackId) {
      serverTrackCheckPending = false;
      return;
    }
    
    getAuthInfo(async function(authInfo) {
      if (!authInfo) {
        serverTrackCheckPending = false;
        return;
      }
      
      try {
        const response = await fetch(`${SERVER_URL}/api/track/verify/${trackId}`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${authInfo.token}`,
            ...(authInfo.sessionId && { 'X-Session-ID': authInfo.sessionId })
          }
        });
        
        if (response.ok) {
          const data = await response.json();
          
          if (!data.inPlaylist) {
            // 승인된 플레이리스트에 없는 트랙
            showTrackNotInPlaylistNotification();
          } else {
            log('트랙이 승인된 플레이리스트에 포함됨');
          }
        }
      } catch (err) {
        console.error('[ODO] 트랙 확인 오류:', err);
      } finally {
        serverTrackCheckPending = false;
      }
    });
  } catch (err) {
    console.error('[ODO] 트랙 확인 프로세스 오류:', err);
    serverTrackCheckPending = false;
  }
}

// 승인되지 않은 트랙 알림 표시
function showTrackNotInPlaylistNotification() {
  showNotification(
    '승인되지 않은 트랙',
    '현재 트랙은 재생 시간에 포함되지 않습니다. 추천 플레이리스트로 이동하시겠습니까?',
    '이동',
    () => {
      // 추천 플레이리스트로 이동
      getRecommendedPlaylist(function(playlist) {
        if (playlist && playlist.url) {
          window.location.href = playlist.url;
        } else {
          log('추천 플레이리스트를 찾을 수 없음');
        }
      });
    },
    true // 취소 버튼 표시
  );
}

// 추천 플레이리스트 가져오기
function getRecommendedPlaylist(callback) {
  getAuthInfo(async function(authInfo) {
    if (!authInfo) {
      callback(null);
      return;
    }
    
    try {
      const response = await fetch(`${SERVER_URL}/api/playlists/recommended`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${authInfo.token}`,
          ...(authInfo.sessionId && { 'X-Session-ID': authInfo.sessionId })
        }
      });
      
      if (response.ok) {
        const data = await response.json();
        if (data.playlists && data.playlists.length > 0) {
          const playlist = data.playlists[0];
          callback({
            id: playlist.youtube_playlist_id,
            name: playlist.title,
            url: `https://music.youtube.com/playlist?list=${playlist.youtube_playlist_id}`
          });
        } else {
          callback(null);
        }
      } else {
        callback(null);
      }
    } catch (err) {
      console.error('[ODO] 추천 플레이리스트 가져오기 오류:', err);
      callback(null);
    }
  });
}

// 알림 표시 함수
function showNotification(title, message, actionText, actionCallback, showCancel = false) {
  // 기존 알림이 있으면 제거
  const existingNotif = document.getElementById('odo-notification');
  if (existingNotif) {
    existingNotif.remove();
  }
  
  // 알림 컨테이너 생성
  const notifContainer = document.createElement('div');
  notifContainer.id = 'odo-notification';
  notifContainer.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: white;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    z-index: 9999;
    width: 320px;
    padding: 16px;
    font-family: 'Roboto', Arial, sans-serif;
  `;
  
  // 컨텐츠 생성
  notifContainer.innerHTML = `
    <div style="margin-bottom: 16px;">
      <h3 style="margin: 0 0 8px 0; font-size: 16px;">${title}</h3>
      <p style="margin: 0; font-size: 14px; color: #5f6368;">${message}</p>
    </div>
    <div style="display: flex; justify-content: ${showCancel ? 'space-between' : 'flex-end'}">
      ${showCancel ? '<button id="odo-notif-cancel" style="background: none; border: none; padding: 8px 12px; cursor: pointer; font-size: 14px; color: #5f6368;">취소</button>' : ''}
      <button id="odo-notif-action" style="background: #4285f4; color: white; border: none; border-radius: 4px; padding: 8px 12px; cursor: pointer; font-size: 14px;">${actionText}</button>
    </div>
  `;
  
  // 문서에 추가
  document.body.appendChild(notifContainer);
  
  // 이벤트 리스너 설정
  document.getElementById('odo-notif-action').addEventListener('click', function() {
    notifContainer.remove();
    if (actionCallback) actionCallback();
  });
  
  if (showCancel) {
    document.getElementById('odo-notif-cancel').addEventListener('click', function() {
      notifContainer.remove();
    });
  }
  
  // 자동 닫기 (10초 후)
  setTimeout(() => {
    if (document.body.contains(notifContainer)) {
      notifContainer.remove();
    }
  }, 10000);
}

// 로그인 화면으로 이동
function handleLogin() {
  chrome.runtime.sendMessage({ action: 'clearSession' });
  window.location.href = `${SERVER_URL}/index.html`;
}

// 탭 닫기
function handleCloseTab() {
  chrome.runtime.sendMessage({ action: 'closeTab' });
}

// 메시지 리스너
chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
  switch (message.action) {
    case 'getTrackHistory':
      // 오늘과 이번 주 통계 계산
      const today = new Date().toISOString().slice(0, 10);
      const todayRecs = trackHistory.filter(r => r.startTime.slice(0, 10) === today);
      const todayMinutes = todayRecs.reduce((sum, r) => sum + Math.floor((r.actualDuration || r.duration) / 60), 0);
      
      sendResponse({
        trackHistory,
        todayStats: { 
          minutes: todayMinutes, 
          tracks: todayRecs.length 
        },
        isPlaying,
        currentTrack,
        playbackStartTime
      });
      return true;
      
    case 'setDebugMode':
      debugMode = message.enabled;
      chrome.storage.local.set({ debugMode });
      log('디버그 모드 설정됨:', debugMode);
      return true;
      
    case 'checkConnection':
      // 연결 상태 확인 명령
      testServerConnection();
      sendResponse({ status: 'checking' });
      return true;
      
    case 'forceCheckState':
      // 강제 상태 확인 명령
      logDOMElements();
      checkCurrentState();
      sendResponse({ status: 'checking' });
      return true;
      
    case 'logDOMState':
      // DOM 요소 상태 로깅 명령
      logDOMElements();
      sendResponse({ status: 'logging' });
      return true;
      
    case 'resetState':
      // 상태 리셋 명령
      resetAllState();
      sendResponse({ status: 'reset' });
      return true;
      
    case 'clearHistory':
      // 히스토리 초기화 명령 추가
      trackHistory = [];
      chrome.storage.local.set({ history: [] });
      log('트랙 히스토리가 초기화되었습니다');
      sendResponse({ status: 'cleared' });
      return true;
  }
});

// 초기화 실행
initialize();