// background.js - 백그라운드 스크립트
let pendingSyncTimer = null;

// 초기화 함수
function initialize() {
  console.log('[ODO] 백그라운드 서비스 초기화');
  
  // 설정 초기화
  initializeConfig();
  
  // // 클라이언트 ID 생성 (없는 경우)
  // initializeClientId();
  
  // // 동기화 스케줄 설정
  // schedulePendingTrackSync();
  
  // 탭 업데이트 리스너 설정
  chrome.tabs.onUpdated.addListener(handleTabUpdated);
  
  // 메시지 리스너 설정
  chrome.runtime.onMessage.addListener(handleMessage);
}

// 설정 초기화
function initializeConfig() {
  chrome.storage.local.get(['dev_mode', 'debug_mode'], data => {
    // 최초 설치 시 기본값 설정
    if (data.dev_mode === undefined) {
      chrome.storage.local.set({ dev_mode: false });
    }
    
    // if (data.debug_mode === undefined) {
    //   chrome.storage.local.set({ debug_mode: true });
    // }
    
    console.log('[ODO] 설정 로드:', { 
      dev_mode: data.dev_mode
    });
  });
}

// // 클라이언트 ID 초기화
// function initializeClientId() {
//   chrome.storage.local.get(['clientId'], data => {
//     if (!data.clientId) {
//       const clientId = 'odo-' + generateUUID();
//       chrome.storage.local.set({ clientId });
//       console.log('[ODO] 새 클라이언트 ID 생성:', clientId);
//     } else {
//       console.log('[ODO] 기존 클라이언트 ID 로드:', data.clientId);
//     }
//   });
// }

// // UUID 생성 함수
// function generateUUID() {
//   return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
//     const r = Math.random() * 16 | 0;
//     return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
//   });
// }

// 탭 업데이트 핸들러
function handleTabUpdated(tabId, changeInfo, tab) {
  if (changeInfo.status === 'complete' && tab.url && (
      tab.url.includes('odo.ist/dashboard.html') || 
      tab.url.includes('localhost:8080/dashboard.html')
    )) {
    // 대시보드 페이지가 로드된 경우, authToken 정보 전달
    chrome.storage.local.get(['token'], data => {
      if (data.token) {
        chrome.scripting.executeScript({
          target: { tabId },
          func: (tokenData) => {
            localStorage.setItem('token', tokenData.token);
          },
          args: [{ token: data.token }]
        }).catch(err => console.error('[ODO] 스크립트 실행 오류:', err));
      }
    });
  }
}

// 메시지 핸들러
function handleMessage(message, sender, sendResponse) {
  console.log('[ODO] 메시지 수신:', message.action);
  
  switch (message.action) {
    case 'updateToken':
      // 토큰 업데이트
      chrome.storage.local.set({ token: message.token });
      if (message.sessionId) {
        chrome.storage.local.set({ sessionId: message.sessionId });
      }
      break;
      
    case 'clearSession':
      // 세션 정보 제거
      chrome.storage.local.remove(['sessionId']);
      break;
      
    case 'updateDevMode':
      // 개발 모드 설정 업데이트
      chrome.storage.local.set({ dev_mode: message.enabled }, () => {
        console.log('[ODO] 개발 모드 설정 변경:', message.enabled);
      });
      break;
      
    case 'getServerUrl':
      // 서버 URL 조회
      chrome.storage.local.get(['dev_mode'], data => {
        const serverUrl = data.dev_mode ? 'http://localhost:8080' : 'https://odo.ist';
        sendResponse({ serverUrl });
      });
      return true; // 비동기 응답을 위해 true 반환
      
    // case 'syncPendingTracks':
    //   // 보류 중인 트랙 동기화
    //   syncPendingTracks();
    //   break;
      
    case 'updateEarnings':
      // 뱃지 텍스트 업데이트
      updateBadgeText(message.count || 0);
      break;
      
    case 'closeTab':
      // 탭 닫기 (세션 만료 등)
      if (sender.tab && sender.tab.id) {
        chrome.tabs.remove(sender.tab.id);
      }
      break;
  }
}

// 보류 중인 트랙 동기화 스케줄 설정
// function schedulePendingTrackSync() {
//   if (pendingSyncTimer) clearInterval(pendingSyncTimer);
//   pendingSyncTimer = setInterval(syncPendingTracks, 10 * 60 * 1000); // 10분마다
// }

// 보류 중인 트랙 동기화
// async function syncPendingTracks() {
//   console.log('[ODO] 보류 중인 트랙 동기화 시작');
  
//   try {
//     const data = await new Promise(resolve => {
//       chrome.storage.local.get(['pending', 'token', 'sessionId'], resolve);
//     });
    
//     const pendingTracks = data.pending || [];
//     const token = data.token;
//     const sessionId = data.sessionId;
    
//     if (!pendingTracks.length || !token) {
//       console.log('[ODO] 동기화할 트랙이 없거나 토큰이 없음');
//       return;
//     }
    
//     // 서버 URL 가져오기
//     const { serverUrl } = await new Promise(resolve => {
//       chrome.runtime.sendMessage({ action: 'getServerUrl' }, resolve);
//     });
    
//     let remaining = [...pendingTracks];
    
//     for (const track of pendingTracks) {
//       try {
//         const response = await fetch(`${serverUrl}/api/listening`, {
//           method: 'POST',
//           headers: {
//             'Content-Type': 'application/json',
//             'Authorization': `Bearer ${token}`,
//             ...(sessionId && { 'X-Session-ID': sessionId })
//           },
//           body: JSON.stringify({
//             youtube_id: track.id,
//             title: track.title,
//             artist: track.artist,
//             duration_seconds: track.duration,
//             client_id: track.record_id,
//             play_start_time: track.startTime,
//             play_end_time: track.endTime,
//             actual_duration_seconds: track.actualDuration || track.duration,
//             is_complete: track.isComplete !== false
//           })
//         });
        
//         if (response.ok) {
//           remaining = remaining.filter(t => t.record_id !== track.record_id);
//           console.log('[ODO] 트랙 동기화 성공:', track.title);
//         } else if (response.status === 401) {
//           // 인증 오류 - 동기화 중단
//           console.error('[ODO] 동기화 중 인증 오류');
//           break;
//         }
//       } catch (e) {
//         console.error('[ODO] 동기화 오류:', e);
//       }
//     }
    
//     // 남은 트랙 저장
//     if (remaining.length !== pendingTracks.length) {
//       chrome.storage.local.set({ pending: remaining });
//       console.log(`[ODO] 동기화 완료. 남은 트랙: ${remaining.length}/${pendingTracks.length}`);
//     }
//   } catch (err) {
//     console.error('[ODO] 동기화 프로세스 오류:', err);
//   }
// }

// 뱃지 텍스트 업데이트
function updateBadgeText(count) {
  chrome.action.setBadgeText({ text: count.toString() });
  chrome.action.setBadgeBackgroundColor({ color: '#4285f4' });
}

// 초기화 실행
initialize();