// popup.js - 팝업 UI 스크립트
document.addEventListener('DOMContentLoaded', function() {
    // DOM 요소
    const darkModeToggle = document.getElementById('dark-mode-toggle');
    const darkModeContainer = document.getElementById('dark-mode-container');
    const devModeToggle = document.getElementById('dev-mode-toggle');
    const dashboardBtn = document.getElementById('dashboard-btn');
    const logoutBtn = document.getElementById('logout-btn');
    const loginPanel = document.getElementById('login-panel');
    const contentPanel = document.getElementById('content-panel');
    const nowPlayingPanel = document.getElementById('now-playing');
    const loginForm = document.getElementById('login-form');
    const loginAlert = document.getElementById('login-alert');
    
    // 상태 변수
    let serverUrl = '';
    let updateTimer = null;
    
    // 팝업 초기화
    initializePopup();
    
    // 이벤트 리스너
    darkModeToggle && darkModeToggle.addEventListener('change', toggleDarkMode);
    devModeToggle && devModeToggle.addEventListener('change', toggleDevMode);
    dashboardBtn.addEventListener('click', openDashboard);
    logoutBtn.addEventListener('click', handleLogout);
    loginForm.addEventListener('submit', handleLogin);
    
    // 팝업 초기화 함수
    function initializePopup() {
      // 개발 모드 설정 로드
      chrome.storage.local.get(['dev_mode'], function(data) {
        const devMode = !!data.dev_mode;
        devModeToggle.checked = devMode;
        serverUrl = devMode ? 'http://localhost:8080' : 'https://odo.ist';
        console.log('[ODO] 서버 URL:', serverUrl);
      });
      
      // 다크 모드 설정 로드
      loadDarkModeSetting();
      
      // 로그인 상태 확인
      checkLoginStatus();
    }
    
    // 로그인 상태 확인
    function checkLoginStatus() {
      chrome.storage.local.get(['token'], function(data) {
        if (data.token) {
          loginPanel.style.display = 'none';
          contentPanel.style.display = 'block';
          darkModeContainer.style.display = 'inline-block';
          
          // 현재 트랙 정보 가져오기
          getCurrentTabInfo();
          
          // 주기적 업데이트 시작
          startPeriodicUpdates();
        } else {
          loginPanel.style.display = 'block';
          contentPanel.style.display = 'none';
          darkModeContainer.style.display = 'none';
          
          // 타이머 정리
          if (updateTimer) {
            clearInterval(updateTimer);
            updateTimer = null;
          }
        }
      });
    }
    
    // 주기적 업데이트 시작
    function startPeriodicUpdates() {
      if (updateTimer) clearInterval(updateTimer);
      updateTimer = setInterval(getCurrentTabInfo, 3000);
    }
    
    // 현재 트랙 정보 가져오기
    function getCurrentTabInfo() {
      chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        const tab = tabs[0];
        if (!tab || !tab.url || !tab.url.includes('music.youtube.com')) {
          updateNotPlayingState('YouTube Music이 열려있지 않습니다.');
          loadMonthlyGoal();
          return;
        }
        
        chrome.tabs.sendMessage(tab.id, {action: "getTrackHistory"}, function(response) {
          if (chrome.runtime.lastError) {
            updateNotPlayingState('YouTube Music과 통신할 수 없습니다.');
            loadMonthlyGoal();
            return;
          }
          
          if (response) {
            updatePopupWithData(response);
          }
        });
      });
    }
    
    // 월간 목표 로드
    function loadMonthlyGoal() {
      chrome.storage.local.get(['token'], function(data) {
        if (!data.token) return;
        
        // 그룹 ID로 해당 그룹의 목표 데이터 로드
        chrome.storage.local.get(['group_id'], function(groupData) {
          if (!groupData.group_id) return;
          
          fetch(`${serverUrl}/api/group/${groupData.group_id}`, {
            headers: {
              'Authorization': `Bearer ${data.token}`
            }
          })
          .then(res => res.json())
          .then(data => {
            if (data.group) {
              updateMonthlyGoal(
                data.group.monthly_goal_minutes || 0, 
                data.group.monthly_min_minutes || 0
              );
            }
          })
          .catch(err => console.error('[ODO] 목표 로드 오류:', err));
        });
      });
    }
    
    // 월간 목표 업데이트
    function updateMonthlyGoal(monthlyGoal, currentMinutes) {
      const monthlyText = document.getElementById('monthly-goal-text');
      const monthlyProg = document.getElementById('monthly-goal-progress');
      
      monthlyText.textContent = `${currentMinutes}/${monthlyGoal}분`;
      
      // 진행율 계산 (최대 100%)
      const progressPercent = monthlyGoal > 0 
        ? Math.min(Math.round((currentMinutes / monthlyGoal) * 100), 100)
        : 0;
      
      monthlyProg.style.width = `${progressPercent}%`;
      
      // 목표 달성 상태에 따라 색상 변경
      if (currentMinutes >= monthlyGoal) {
        monthlyProg.style.backgroundColor = '#34a853'; // 녹색
      } else if (currentMinutes >= monthlyGoal * 0.7) {
        monthlyProg.style.backgroundColor = '#fbbc05'; // 노란색
      } else {
        monthlyProg.style.backgroundColor = '#4285f4'; // 파란색
      }
    }
    
    // 팝업 데이터 업데이트
    function updatePopupWithData(data) {
      updateNowPlaying(data);
      updateStats(data);
      
      // 월간 목표 로드
      loadMonthlyGoal();
    }
    
    // 현재 재생 중인 트랙 정보 업데이트
    function updateNowPlaying(data) {
      const titleEl = nowPlayingPanel.querySelector('.track-title');
      const artistEl = nowPlayingPanel.querySelector('.track-artist');
      const statusEl = document.getElementById('playback-status');
      const timeEl = document.getElementById('playback-time');
      
      if (data.currentTrack && data.isPlaying) {
        titleEl.textContent = data.currentTrack.title;
        artistEl.textContent = data.currentTrack.artist;
        statusEl.textContent = '재생 중';
        
        if (data.playbackStartTime) {
          const d = Math.floor((Date.now() - data.playbackStartTime) / 1000);
          timeEl.textContent = `${Math.floor(d/60)}:${String(d%60).padStart(2,'0')}`;
        }
        
        nowPlayingPanel.classList.add('active');
      } else if (data.currentTrack) {
        titleEl.textContent = data.currentTrack.title;
        artistEl.textContent = data.currentTrack.artist;
        statusEl.textContent = '일시정지됨';
        timeEl.textContent = '';
        nowPlayingPanel.classList.remove('active');
      } else {
        updateNotPlayingState('음악을 재생하지 않음');
      }
    }
    
    // 재생 중이 아닌 상태 표시
    function updateNotPlayingState(msg) {
      nowPlayingPanel.querySelector('.track-title').textContent = msg;
      nowPlayingPanel.querySelector('.track-artist').textContent = 'YouTube Music에서 음악을 재생해보세요';
      document.getElementById('playback-status').textContent = '대기 중';
      document.getElementById('playback-time').textContent = '';
      nowPlayingPanel.classList.remove('active');
    }
    
    // 통계 업데이트
    function updateStats(data) {
      document.getElementById('today-tracks').textContent = data.todayStats?.tracks || 0;
      document.getElementById('today-minutes').textContent = data.todayStats?.minutes || 0;
    }
    
    // 다크 모드 설정 로드
    function loadDarkModeSetting() {
      chrome.storage.local.get(['darkMode'], function(data) {
        const isDarkMode = !!data.darkMode;
        if (isDarkMode) document.body.classList.add('dark-mode');
        if (darkModeToggle) darkModeToggle.checked = isDarkMode;
      });
    }
    
    // 다크 모드 토글
    function toggleDarkMode() {
      const enabled = darkModeToggle.checked;
      chrome.storage.local.set({ darkMode: enabled });
      document.body.classList.toggle('dark-mode', enabled);
    }
    
    // 개발 모드 토글
    function toggleDevMode() {
      const enabled = devModeToggle.checked;
      chrome.storage.local.set({ dev_mode: enabled });
      
      // 백그라운드 스크립트에 알림
      chrome.runtime.sendMessage({ 
        action: 'updateDevMode', 
        enabled: enabled 
      });
      
      // 서버 URL 업데이트
      serverUrl = enabled ? 'http://localhost:8080' : 'https://odo.ist';
      console.log('[ODO] 서버 URL 변경:', serverUrl);
    }
    
    // 대시보드 열기
    function openDashboard() {
      chrome.tabs.create({ url: `${serverUrl}/dashboard.html` });
    }
    
    // 로그인 처리
    async function handleLogin(e) {
      e.preventDefault();
      
      const userId = document.getElementById('userId').value;
      const password = document.getElementById('password').value;
      
      if (!userId || !password) {
        showLoginError('아이디와 비밀번호를 모두 입력해주세요.');
        return;
      }
      
      try {
        // 로그인 버튼 비활성화
        const submitBtn = loginForm.querySelector('button[type="submit"]');
        const originalText = submitBtn.textContent;
        submitBtn.disabled = true;
        submitBtn.textContent = '로그인 중...';
        
        const response = await fetch(`${serverUrl}/api/login`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ user_id: userId, password })
        });
        
        const data = await response.json();
        
        // 로그인 버튼 복원
        submitBtn.disabled = false;
        submitBtn.textContent = originalText;
        
        if (response.ok) {
          // 토큰 저장
          chrome.storage.local.set({ token: data.token });
          
          // 사용자 정보 저장
          if (data.user) {
            chrome.storage.local.set({ 
              username: data.user.username,
              group_id: data.user.group_id
            });
          }
          
          // 세션 생성 요청
          await createSession(data.token);
          
          // UI 업데이트
          loginPanel.style.display = 'none';
          contentPanel.style.display = 'block';
          darkModeContainer.style.display = 'inline-block';
          
          // 현재 트랙 정보 가져오기
          getCurrentTabInfo();
          
          // 주기적 업데이트 시작
          startPeriodicUpdates();
        } else {
          showLoginError(data.error || '로그인에 실패했습니다.');
        }
      } catch (err) {
        console.error('[ODO] 로그인 오류:', err);
        showLoginError('서버 연결에 실패했습니다.');
      }
    }
    
    // 세션 생성
    async function createSession(token) {
      try {
        // 기기 정보 수집
        const deviceInfo = {
          screenWidth: window.screen.width,
          screenHeight: window.screen.height,
          userAgent: navigator.userAgent,
          platform: navigator.platform,
          language: navigator.language
        };
        
        const response = await fetch(`${serverUrl}/api/session`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({ device_info: deviceInfo })
        });
        
        const data = await response.json();
        
        if (response.ok && data.sessionId) {
          chrome.storage.local.set({ sessionId: data.sessionId });
          console.log('[ODO] 세션 생성 성공:', data.sessionId);
          
          // 백그라운드 스크립트에 알림
          chrome.runtime.sendMessage({ 
            action: 'updateToken', 
            token: token,
            sessionId: data.sessionId
          });
        }
      } catch (err) {
        console.error('[ODO] 세션 생성 오류:', err);
      }
    }
    
    // 로그인 오류 표시
    function showLoginError(message) {
      loginAlert.textContent = message;
      loginAlert.style.display = 'block';
      
      // 3초 후 오류 메시지 숨기기
      setTimeout(() => {
        loginAlert.style.display = 'none';
      }, 3000);
    }
    
    // 로그아웃 처리
    function handleLogout() {
      // 세션 종료 요청
      chrome.storage.local.get(['token', 'sessionId'], async function(data) {
        if (data.token && data.sessionId) {
          try {
            await fetch(`${serverUrl}/api/session`, {
              method: 'DELETE',
              headers: {
                'Authorization': `Bearer ${data.token}`,
                'X-Session-ID': data.sessionId
              }
            });
          } catch (err) {
            console.error('[ODO] 세션 종료 오류:', err);
          }
        }
        
        // 스토리지에서 인증 정보 제거
        chrome.storage.local.remove(['token', 'sessionId', 'username', 'group_id']);
        
        // 백그라운드 스크립트에 알림
        chrome.runtime.sendMessage({ action: 'clearSession' });
        
        // UI 업데이트
        loginPanel.style.display = 'block';
        contentPanel.style.display = 'none';
        darkModeContainer.style.display = 'none';
        
        // 타이머 정리
        if (updateTimer) {
          clearInterval(updateTimer);
          updateTimer = null;
        }
      });
    }
    
    // 팝업 닫힐 때 타이머 정리
    window.addEventListener('unload', function() {
      if (updateTimer) {
        clearInterval(updateTimer);
        updateTimer = null;
      }
    });
  });