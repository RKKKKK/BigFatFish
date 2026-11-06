// Adapted from MeteorNOX dsh-whale-widget (MIT). Scheduling modules removed; money display uses two decimals.
(function () {
  if (window.__dshWhaleWidget) return;
  window.__dshWhaleWidget = true;
  var dshwEnabled = true;
  function dshwInit() {
    if (window.__dshWhaleInit) return;
    window.__dshWhaleInit = true;
    var MIN_SCALE = 0.6;
    var MAX_SCALE = 2.5;
    var STEP = 0.1;
    var CLICK_SQ = 9;
    var QUOTA_POLL_MS = 10000;


    var BUBBLE_MS = 5000;
    var usageClient = WhaleUsageClient.create({
      fetchImpl: window.fetch.bind(window),
      shouldNotify: WhaleTurnNotice.shouldNotify,
      storage: {
        getItem: function (key) { return localStorage.getItem(key); },
        setItem: function (key, value) { localStorage.setItem(key, value); }
      }
    });
    var bubbleQueue = WhaleBubbleQueue.create({
      show: function (item) {
        if (item.kind === 'cost') return sceneOpen('cost', function () { bubbleRenderCost(item.amount, item.notice); }, 0);
        return sceneOpen(item.kind, function () { bubbleRenderText(item.rows || []); }, 0);
      },
      hide: function () { closeBubbleScene(); }
    });
    var SIZE_URL = '/dsh-whale/size.json';
    var IMG_URL = '/dsh-whale/image.png?v=2';
    var assetWarnings = Object.create(null);
    function assetNotice(message) {
      if (window.whaleToast) window.whaleToast(String(message || '素材操作未完成，请重试'));
    }
    function assetWarning(data) {
      if (data && data.warning && !assetWarnings[data.warning]) {
        assetWarnings[data.warning] = true;
        assetNotice(data.warning);
      }
    }
    function requireSaved(data) {
      if (!data || data.ok !== true) throw new Error(data && data.error || '保存未完成，请重试');
      assetWarning(data);
      return data;
    }
    function assetFailure(error) { assetNotice(error && error.message || '保存未完成，请重试'); }
    function mediaDataUrl(blob) {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () { resolve(String(reader.result || '')); };
        reader.onerror = function () { reject(new Error('文件读取失败，请重新选择')); };
        reader.readAsDataURL(blob);
      });
    }
    var root = document.createElement('div');
    root.className = 'dshwv-root';
    var positioner = document.createElement('div');
    positioner.className = 'dshwv-position';
    positioner.appendChild(root);
    var img = document.createElement('img');
    img.className = 'dshwv-img';
    var initRoleUrl = IMG_URL;
    try {
      var initRoleId = localStorage.getItem('dshw-role') || '';
      if (initRoleId && initRoleId !== 'default') initRoleUrl = '/dsh-whale/role-image.png?id=' + encodeURIComponent(initRoleId);
    } catch (err) {}
    img.src = initRoleUrl;
    img.alt = '当前 API 余额';
    img.draggable = false;
    var menuBtn = document.createElement('button');
    menuBtn.type = 'button';
    menuBtn.className = 'dshwv-menu-btn';
    menuBtn.title = '菜单';
    menuBtn.innerHTML = '<span></span><span></span><span></span>';
    menuBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleMenu();
    });
    var menuBox = document.createElement('div');
    menuBox.className = 'dshwv-menu';
    menuBox.addEventListener('scroll', function () {
      dshwCustSelClose(); closeRolePanel(); closeAudioGroupPanel();
      closeFxInfo();
    });
    function menuLabel(text) {
      var s = document.createElement('span');
      s.textContent = text;
      return s;
    }
    function menuRow() {
      var r = document.createElement('div');
      r.className = 'dshwv-menu-row';
      return r;
    }
    // The menu reads top to bottom: 主题, 外观, 声音, 气泡与金额, 桌面, then the
    // two panels and the commands.
    function menuSection(title) {
      var section = document.createElement('section');
      section.className = 'dshwv-menu-sec';
      var head = document.createElement('h3');
      head.className = 'dshwv-menu-head';
      head.textContent = title;
      section.appendChild(head);
      menuBox.appendChild(section);
      return section;
    }
    var MENU_ICONS = {
      gauge: '<path d="M3.5 17a8.5 8.5 0 1 1 17 0"/><path d="M12 17l4.2-5.2"/><circle cx="12" cy="17" r="1.3"/>',
      chat: '<path d="M20.5 11.5a8 8 0 0 1-11.8 7L4 20l1.5-4.4a8 8 0 1 1 15-4.1z"/>',
      refresh: '<path d="M21 4v6h-6"/><path d="M19.5 15a8 8 0 1 1-1.9-8.3L21 10"/>',
      bars: '<path d="M5 20v-8M12 20V5M19 20v-5"/>',
      pulse: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
      power: '<path d="M12 3v8"/><path d="M6.3 7.3a8 8 0 1 0 11.4 0"/>'
    };
    function menuIcon(name) {
      var holder = document.createElement('span');
      holder.className = 'dshwv-icon';
      holder.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + MENU_ICONS[name] + '</svg>';
      return holder;
    }
    var secTheme = menuSection('主题'), secLook = menuSection('外观'), secSound = menuSection('声音');
    var secBubble = menuSection('气泡与金额'), secDesk = menuSection('桌面');
    // Three color themes; the choice is kept by desktop/ui/theme.js.
    var themeApi = window.WhaleTheme;
    var themePicks = document.createElement('div');
    themePicks.className = 'dshwv-theme-picks';
    themePicks.setAttribute('role', 'group');
    themePicks.setAttribute('aria-label', '主题');
    (themeApi ? themeApi.themes : []).forEach(function (theme) {
      var pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'dshwv-theme-pick';
      pick.dataset.themeId = theme.id;
      pick.title = theme.name;
      var swatch = document.createElement('span');
      swatch.className = 'dshwv-theme-swatch dshwv-theme-swatch-' + theme.id;
      pick.appendChild(swatch);
      pick.appendChild(menuLabel(theme.name));
      pick.addEventListener('click', function (e) {
        e.stopPropagation();
        themeApi.set(theme.id);
      });
      themePicks.appendChild(pick);
    });
    function syncThemePicks() {
      var current = themeApi ? themeApi.current() : '';
      Array.prototype.forEach.call(themePicks.children, function (pick) {
        pick.setAttribute('aria-pressed', String(pick.dataset.themeId === current));
      });
    }
    syncThemePicks();
    window.addEventListener('whale-theme', syncThemePicks);
    secTheme.appendChild(themePicks);
    // The filled part of a slider, which the stylesheet draws from --p.
    function paintRange(input) {
      try {
        var min = Number(input.min) || 0, max = Number(input.max) || 1;
        input.style.setProperty('--p', Math.max(0, Math.min(100, (Number(input.value) - min) / (max - min) * 100)) + '%');
      } catch (err) {}
    }
    var scaleInput = document.createElement('input');
    scaleInput.type = 'range';
    scaleInput.min = String(MIN_SCALE);
    scaleInput.max = String(MAX_SCALE);
    scaleInput.step = '0.1';
    scaleInput.className = 'dshwv-range';
    scaleInput.value = '1.5';
    paintRange(scaleInput);
    var scaleNumber = document.createElement('input');
    scaleNumber.type = 'number';
    scaleNumber.min = '1';
    scaleNumber.max = '20';
    scaleNumber.step = '1';
    scaleNumber.className = 'dshwv-number';
    scaleNumber.value = '10';
    scaleInput.addEventListener('pointerdown', function () {
      positioner.style.transition = 'none';
    });
    scaleInput.addEventListener('input', function () {
      setScale(scaleInput.value);
    });
    scaleInput.addEventListener('change', function () {
      positioner.style.transition = '';
      try {
        refreshFlip();
      } catch (err) {}
    });
    scaleNumber.addEventListener('focus', function () {
      positioner.style.transition = 'none';
    });
    scaleNumber.addEventListener('blur', function () {
      positioner.style.transition = '';
    });
    scaleNumber.addEventListener('input', function () {
      var v = Math.round(Number(scaleNumber.value));
      var s = MIN_SCALE + Math.max(0, Math.min(20, v) - 1) * (MAX_SCALE - MIN_SCALE) / 19;
      setScale(s);
    });
    scaleNumber.addEventListener('change', function () {
      var v = Math.round(Number(scaleNumber.value));
      var s = MIN_SCALE + Math.max(0, Math.min(20, v) - 1) * (MAX_SCALE - MIN_SCALE) / 19;
      setScale(s);
      positioner.style.transition = '';
      try {
        refreshFlip();
      } catch (err) {}
    });
    var audioGroupBtn = document.createElement('button');
    audioGroupBtn.type = 'button';
    audioGroupBtn.className = 'dshwv-audiobtn';
    audioGroupBtn.title = '选择音效组';
    var audioGroupBtnLabel = document.createElement('span');
    audioGroupBtnLabel.className = 'dshwv-btnlabel';
    audioGroupBtnLabel.textContent = '小黄鸭';
    audioGroupBtn.appendChild(audioGroupBtnLabel);
    var audioGroupPanel = document.createElement('div');
    audioGroupPanel.className = 'dshwv-audiolist';
    var audioImportBtn = document.createElement('button');
    audioImportBtn.type = 'button';
    audioImportBtn.className = 'dshwv-audioimport';
    audioImportBtn.textContent = '导入';
    audioImportBtn.title = '新建/编辑音效组';
    audioGroupBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleAudioGroupPanel();
    });
    audioImportBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      openAudioGroupEditor(null);
    });
    document.body.appendChild(audioGroupPanel);
    function soundOpt(value, label) {
      var o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      return o;
    }
    var dshwCustSelOpen = null;
    var dshwCustSuppressAt = 0;
    function dshwCustSelClose() {
      var o = dshwCustSelOpen;
      dshwCustSelOpen = null;
      if (!o) return;
      try {
        o.menu.classList.remove('dshwv-rgbopen');
        if (o.menu.parentNode === document.body) document.body.removeChild(o.menu);
      } catch (err) {}
    }
    if (!window.__dshwCustBound) {
      window.__dshwCustBound = true;
      document.addEventListener('pointerdown', function (e) {
        var o = dshwCustSelOpen;
        if (!o) return;
        try {
          var onBtn = !!(e.target && e.target.closest && e.target.closest('.dshwv-custbtn'));
          if (onBtn) {
            dshwCustCloseNow();
            return;
          }
          if (e.target && o.menu.contains(e.target)) return;
        } catch (err) {}
        dshwCustSelClose();
      }, true);
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') dshwCustCloseNow();
      }, true);
      window.addEventListener('resize', function () {
        dshwCustCloseNow();
      });
    }
    function dshwCustCloseNow() {
      dshwCustSelClose();
      dshwCustSuppressAt = Date.now();
    }
    var taskEndDrop = null;
    var approvalSoundDrop = null;
    var pomodoroSoundDrop = null;
    var moduleImgDrop = null;
    function dshwCustSel(sel, opts) {
      if (!sel || !sel.parentNode || sel.__dshwCust) return {
        sync: function () {},
        refresh: function () {}
      };
      sel.__dshwCust = true;
      var parent = sel.parentNode;
      var wrap = document.createElement('div');
      wrap.className = 'dshwv-custwrap';
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dshwv-custbtn';
      btn.title = sel.title || '';
      var lab = document.createElement('span');
      lab.className = 'dshwv-custlab';
      btn.appendChild(lab);
      parent.insertBefore(wrap, sel);
      wrap.appendChild(btn);
      wrap.appendChild(sel);
      sel.style.display = 'none';
      var menu = document.createElement('div');
      menu.className = 'dshwv-rgbmenu dshwv-custmenu';
      function labelOf(v) {
        for (var i = 0; i < sel.options.length; i++) {
          if (String(sel.options[i].value) === String(v)) return String(sel.options[i].textContent || sel.options[i].text || '');
        }
        return '';
      }
      function sync() {
        try {
          lab.textContent = labelOf(sel.value) || '—';
          btn.disabled = !!sel.disabled;
        } catch (err) {}
      }
      function fill() {
        menu.innerHTML = '';
        var cur = sel.value;
        for (var i = 0; i < sel.options.length; i++) {
          (function (opt) {
            var d = document.createElement('div');
            var lab = String(opt.textContent || opt.text || opt.value);
            if (opts && opts.scrollNames) {
              d.className = 'dshwv-rgbopt dshwv-custrow' + (String(opt.value) === String(cur) ? ' dshwv-rgbcur' : '');
              var nm = makeNameCell('dshwv-custnm', lab);
              d.appendChild(nm);
              bindNameMarquee(d, nm);
            } else {
              d.className = 'dshwv-rgbopt' + (String(opt.value) === String(cur) ? ' dshwv-rgbcur' : '');
              d.textContent = lab;
            }
            d.addEventListener('click', function (e) {
              e.stopPropagation();
              try {
                sel.value = opt.value;
              } catch (err) {}
              sync();
              dshwCustSelClose();
              try {
                sel.dispatchEvent(new Event('change'));
              } catch (err) {}
            });
            menu.appendChild(d);
          })(sel.options[i]);
        }
      }
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (btn.disabled) return;
        if (dshwCustSuppressAt && Date.now() - dshwCustSuppressAt < 350) {
          dshwCustSuppressAt = 0;
          return;
        }
        if (dshwCustSelOpen && dshwCustSelOpen.btn === btn) {
          dshwCustSelClose();
          return;
        }
        dshwCustSelClose();
        fill();
        sync();
        if (menu.parentNode !== document.body) document.body.appendChild(menu);
        dshwDropOpen(menu, btn);
        if (opts && typeof opts.bottom === 'function') {
          try {
            var bEl = opts.bottom();
            if (bEl && bEl.getBoundingClientRect) {
              var bTop = bEl.getBoundingClientRect().top;
              var mTop = menu.getBoundingClientRect().top;
              var avail = Math.floor(bTop - mTop - 6);
              if (avail >= 40) menu.style.maxHeight = Math.min(avail, 220) + 'px';
            }
          } catch (err) {}
        }
        dshwCustSelOpen = {
          menu: menu,
          btn: btn
        };
      });
      sync();
      return {
        sync: sync,
        refresh: function () {
          fill();
          sync();
        }
      };
    }
    function openQuotaRecords() {
      closeMenu();
      window.dispatchEvent(new CustomEvent('whale-open-settings', { detail: { tab: 'records' } }));
    }
    var taskEndToggle = document.createElement('input');
    taskEndToggle.type = 'checkbox';
    taskEndToggle.className = 'dshwv-check';
    taskEndToggle.checked = false;
    taskEndToggle.title = '每轮对话回复完成时播放提示音';
    taskEndToggle.addEventListener('change', function () {
      usageSet = usageSet || ({});
      usageSet.taskEnd = usageSet.taskEnd || ({
        on: false,
        sel: ''
      });
      usageSet.taskEnd.on = taskEndToggle.checked;
      taskEndSel.disabled = !taskEndToggle.checked;
      if (taskEndDrop) taskEndDrop.refresh();
      saveUsageSettings({
        taskEnd: usageSet.taskEnd
      });
    });
    var taskEndSel = document.createElement('select');
    taskEndSel.className = 'dshwv-sound';
    taskEndSel.disabled = true;
    taskEndSel.title = '选择任务结束音:音效组(点按整组)/单个音频(与按下/松开同库)';
    taskEndSel.addEventListener('change', function () {
      usageSet = usageSet || ({});
      usageSet.taskEnd = usageSet.taskEnd || ({
        on: false,
        sel: ''
      });
      usageSet.taskEnd.sel = taskEndSel.value;
      saveUsageSettings({
        taskEnd: usageSet.taskEnd
      });
    });
    var approvalSoundToggle = document.createElement('input');
    approvalSoundToggle.type = 'checkbox';
    approvalSoundToggle.className = 'dshwv-check';
    approvalSoundToggle.checked = true;
    approvalSoundToggle.title = '收到 Codex 权限请求时播放提示音';
    approvalSoundToggle.addEventListener('change', function () {
      usageSet = usageSet || ({});
      usageSet.approvalSound = usageSet.approvalSound || { on: true, sel: 'preset:fx1:release' };
      usageSet.approvalSound.on = approvalSoundToggle.checked;
      approvalSoundSel.disabled = !approvalSoundToggle.checked;
      if (approvalSoundDrop) approvalSoundDrop.refresh();
      saveUsageSettings({ approvalSound: usageSet.approvalSound });
    });
    var approvalSoundSel = document.createElement('select');
    approvalSoundSel.className = 'dshwv-sound';
    approvalSoundSel.title = '选择审批提醒音：音效组或自定义音频片段';
    approvalSoundSel.addEventListener('change', function () {
      usageSet = usageSet || ({});
      usageSet.approvalSound = usageSet.approvalSound || { on: true, sel: 'preset:fx1:release' };
      usageSet.approvalSound.sel = approvalSoundSel.value;
      saveUsageSettings({ approvalSound: usageSet.approvalSound });
    });
    var pomodoroSoundToggle = document.createElement('input');
    pomodoroSoundToggle.type = 'checkbox';
    pomodoroSoundToggle.className = 'dshwv-check';
    pomodoroSoundToggle.checked = true;
    pomodoroSoundToggle.title = '番茄钟阶段结束时播放提示音';
    pomodoroSoundToggle.addEventListener('change', function () {
      usageSet = usageSet || {};
      usageSet.pomodoroSound = usageSet.pomodoroSound || { on: true, sel: 'preset:fx1:release' };
      usageSet.pomodoroSound.on = pomodoroSoundToggle.checked;
      pomodoroSoundSel.disabled = !pomodoroSoundToggle.checked;
      if (pomodoroSoundDrop) pomodoroSoundDrop.refresh();
      saveUsageSettings({ pomodoroSound: usageSet.pomodoroSound });
    });
    var pomodoroSoundSel = document.createElement('select');
    pomodoroSoundSel.className = 'dshwv-sound';
    pomodoroSoundSel.title = '选择番茄钟提醒音：音效组或自定义音频片段';
    pomodoroSoundSel.addEventListener('change', function () {
      usageSet = usageSet || {};
      usageSet.pomodoroSound = usageSet.pomodoroSound || { on: true, sel: 'preset:fx1:release' };
      usageSet.pomodoroSound.sel = pomodoroSoundSel.value;
      saveUsageSettings({ pomodoroSound: usageSet.pomodoroSound });
    });
    function fillTaskEndOptions(pref) {
      var prefSel = usageSet && usageSet.taskEnd && usageSet.taskEnd.sel || pref && pref.sel || '';
      var cur = taskEndSel.value || prefSel || '';
      taskEndSel.innerHTML = '';
      var seen = {};
      var seenLbl = {};
      function add(v, lab) {
        if (seen[v]) return;
        if (seenLbl[lab]) return;
        seen[v] = 1;
        seenLbl[lab] = 1;
        taskEndSel.appendChild(soundOpt(v, lab));
      }
      var grps = Array.isArray(audioGroups) ? audioGroups : [];
      for (var gi = 0; gi < grps.length; gi++) {
        var gg = grps[gi];
        if (!gg || !gg.id) continue;
        var gv = 'grp:' + gg.id;
        if (seen[gv]) continue;
        seen[gv] = 1;
        taskEndSel.appendChild(soundOpt(gv, String(gg.name || audioGroupName(gg.id)) + '（点按）'));
      }
      var pre = [['preset:duck:press', '小黄鸭·按下'], ['preset:duck:release', '小黄鸭·松开'], ['preset:fx1:press', '音效1·按下'], ['preset:fx1:release', '音效1·松开']];
      pre.forEach(function (o) {
        add(o[0], o[1]);
      });
      var frags = Array.isArray(audioFragments) ? audioFragments : [];
      frags.forEach(function (f) {
        if (!f || !f.id) return;
        if (f.preset) return;
        add('frag:' + f.id, String(f.name || f.id));
      });
      var fragN = 0;
      for (var fi = 0; fi < taskEndSel.options.length; fi++) if (String(taskEndSel.options[fi].value).indexOf('frag:') === 0) fragN++;
      var found = false;
      for (var i = 0; i < taskEndSel.options.length; i++) if (taskEndSel.options[i].value === cur) {
        taskEndSel.value = cur;
        found = true;
        break;
      }
      if (!found) {
        if (cur && String(cur).indexOf('frag:') === 0 && fragN === 0) {
          taskEndSel.value = '';
          if (taskEndDrop) taskEndDrop.refresh();
          return;
        }
        if (cur && String(cur).indexOf('grp:') === 0 && (!Array.isArray(audioGroups) || audioGroups.length === 0)) {
          taskEndSel.value = '';
          if (taskEndDrop) taskEndDrop.refresh();
          return;
        }
        var chosen = 'preset:duck:press';
        for (var j = 0; j < taskEndSel.options.length; j++) {
          var v = taskEndSel.options[j].value;
          if (v.indexOf('frag:') === 0) {
            chosen = v;
            if (String(taskEndSel.options[j].textContent || '') === 'entity') break;
          }
        }
        taskEndSel.value = chosen;
        usageSet = usageSet || ({});
        usageSet.taskEnd = usageSet.taskEnd || ({
          on: false,
          sel: ''
        });
        usageSet.taskEnd.sel = chosen;
      }
      if (pref && pref.sel) {
        for (var k = 0; k < taskEndSel.options.length; k++) if (taskEndSel.options[k].value === pref.sel) taskEndSel.value = pref.sel;
      }
      var seen2 = {};
      for (var di = taskEndSel.options.length - 1; di >= 0; di--) {
        var dv = taskEndSel.options[di].value;
        if (seen2[dv]) {
          try {
            taskEndSel.remove(di);
          } catch (err) {}
        } else seen2[dv] = 1;
      }
      if (taskEndDrop) taskEndDrop.refresh();
    }
    function fillReminderSoundOptions(select, drop, key, pref) {
      var selected = pref && pref.sel || select.value || 'preset:fx1:release';
      select.replaceChildren();
      for (var i = 0; i < taskEndSel.options.length; i++) select.appendChild(taskEndSel.options[i].cloneNode(true));
      var found = false;
      for (var j = 0; j < select.options.length; j++) if (select.options[j].value === selected) {
        found = true;
        break;
      }
      select.value = found ? selected : 'preset:fx1:release';
      if (!found && audioLoaded && usageSet && usageSet[key]) usageSet[key].sel = select.value;
      if (drop) drop.refresh();
    }
    function refreshTaskEndAfterAudio() {
      try {
        fillTaskEndOptions(usageSet && usageSet.taskEnd || null);
        fillReminderSoundOptions(approvalSoundSel, approvalSoundDrop, 'approvalSound', usageSet && usageSet.approvalSound);
        fillReminderSoundOptions(pomodoroSoundSel, pomodoroSoundDrop, 'pomodoroSound', usageSet && usageSet.pomodoroSound);
      } catch (err) {}
    }
    function playTaskEndSound() {
      try {
        if (!usageSet || !usageSet.taskEnd || !usageSet.taskEnd.on || soundOn === false) return;
        playSelectedSound(usageSet.taskEnd.sel || taskEndSel.value || '');
      } catch (err) {}
    }
    function playSelectedSound(sel) {
      try {
        var url = '';
        if (sel.indexOf('grp:') === 0) {
          playSoundGroupClick(sel.slice(4));
          return;
        }
        if (sel.indexOf('frag:') === 0) url = '/dsh-whale/audio-fragment.wav?id=' + encodeURIComponent(sel.slice(5)); else if (sel.indexOf('preset:') === 0) {
          var parts = sel.split(':');
          url = '/dsh-whale/sound/' + (parts[2] === 'release' ? 'release' : 'press') + '.mp3?set=' + parts[1];
        }
        if (!url) return;
        var a = new Audio(url);
        try {
          a.volume = Number(soundVol) || 0.9;
        } catch (err) {}
        a.play().catch(function () {});
      } catch (err) {}
    }
    function playSoundGroupClick(groupId) {
      try {
        if (!groupId) return;
        var g = null;
        for (var gi = 0; gi < audioGroups.length; gi++) if (audioGroups[gi] && audioGroups[gi].id === groupId) {
          g = audioGroups[gi];
          break;
        }
        var pressEmpty = !!(g && g.press === '');
        var releaseEmpty = !!(g && g.release === '');
        if (pressEmpty && releaseEmpty) return;
        var vol = Number(soundVol) || 0.9;
        if (pressEmpty) {
          if (!releaseEmpty) {
            var relOnly = new Audio('/dsh-whale/sound/release.mp3?set=' + encodeURIComponent(groupId));
            try {
              relOnly.volume = vol;
            } catch (err) {}
            relOnly.currentTime = 0;
            var pr = relOnly.play();
            if (pr && pr.catch) pr.catch(function () {});
          }
          return;
        }
        var press = new Audio('/dsh-whale/sound/press.mp3?set=' + encodeURIComponent(groupId));
        try {
          press.volume = vol;
        } catch (err) {}
        if (releaseEmpty) {
          press.currentTime = 0;
          var pp = press.play();
          if (pp && pp.catch) pp.catch(function () {});
          return;
        }
        var release = new Audio('/dsh-whale/sound/release.mp3?set=' + encodeURIComponent(groupId));
        try {
          release.volume = vol;
        } catch (err) {}
        var relPlayed = false;
        function playRel() {
          if (relPlayed) return;
          relPlayed = true;
          try {
            release.currentTime = 0;
            var p = release.play();
            if (p && p.catch) p.catch(function () {});
          } catch (err) {}
        }
        press.onended = function () {
          playRel();
        };
        press.currentTime = 0;
        var p0 = press.play();
        if (p0 && p0.catch) p0.catch(function () {});
      } catch (err) {}
    }
    var bubbleToggle = document.createElement('input');
    bubbleToggle.type = 'checkbox';
    bubbleToggle.className = 'dshwv-check';
    bubbleToggle.checked = true;
    bubbleToggle.title = '关闭后点角色不再弹出额度气泡，任务完成和提醒也不弹出';
    bubbleToggle.addEventListener('change', function () {
      setBubbleOn(bubbleToggle.checked);
    });
    var turnCostToggle = document.createElement('input');
    turnCostToggle.type = 'checkbox';
    turnCostToggle.className = 'dshwv-check';
    turnCostToggle.checked = true;
    turnCostToggle.title = '每轮对话结束后自动显示本轮消耗金额';
    turnCostToggle.addEventListener('change', function () {
      setTurnCostOn(turnCostToggle.checked);
    });
    var turnCostCloseInput = document.createElement('input');
    turnCostCloseInput.type = 'number';
    turnCostCloseInput.min = '0';
    turnCostCloseInput.step = '1';
    turnCostCloseInput.className = 'dshwv-number';
    turnCostCloseInput.value = '5';
    turnCostCloseInput.disabled = false;
    turnCostCloseInput.title = '填 0 表示不自动关闭，需手动点击关闭';
    turnCostCloseInput.addEventListener('input', function () {
      setTurnCostClose(turnCostCloseInput.value);
    });
    turnCostCloseInput.addEventListener('change', function () {
      setTurnCostClose(turnCostCloseInput.value);
    });
    var scrollGapToggle = document.createElement('input');
    scrollGapToggle.type = 'checkbox';
    scrollGapToggle.className = 'dshwv-check';
    scrollGapToggle.checked = false;
    scrollGapToggle.title = '开启后挂件右侧按设定像素避开滚动条；关闭则贴边（盖住滚动条）';
    scrollGapToggle.addEventListener('change', function () {
      setScrollGapOn(scrollGapToggle.checked);
    });
    var scrollGapInput = document.createElement('input');
    scrollGapInput.type = 'number';
    scrollGapInput.min = '0';
    scrollGapInput.step = '1';
    scrollGapInput.className = 'dshwv-number';
    scrollGapInput.value = '17';
    scrollGapInput.disabled = true;
    scrollGapInput.title = '避让滚动条的像素宽度，填 0 表示贴边';
    scrollGapInput.addEventListener('input', function () {
      setScrollGapPx(scrollGapInput.value);
    });
    scrollGapInput.addEventListener('change', function () {
      setScrollGapPx(scrollGapInput.value);
    });
    var row1 = menuRow();
    row1.appendChild(menuLabel('大小'));
    row1.appendChild(scaleInput);
    row1.appendChild(scaleNumber);
    var row2 = menuRow();
    row2.appendChild(menuLabel('音效'));
    row2.appendChild(audioGroupBtn);
    row2.appendChild(audioImportBtn);
    var volInput = document.createElement('input');
    volInput.type = 'range';
    volInput.min = '0';
    volInput.max = '1';
    volInput.step = '0.05';
    volInput.className = 'dshwv-range';
    volInput.value = '0.9';
    paintRange(volInput);
    var volPct = document.createElement('span');
    volPct.className = 'dshwv-volpct';
    volPct.textContent = '90%';
    volInput.addEventListener('input', function () {
      setVol(volInput.value);
    });
    var row3 = menuRow();
    row3.appendChild(menuLabel('音量'));
    row3.appendChild(volInput);
    row3.appendChild(volPct);
    var row6 = menuRow();
    row6.appendChild(menuLabel('气泡'));
    row6.appendChild(bubbleToggle);
    var row7 = menuRow();
    row7.appendChild(menuLabel('每轮消耗提示'));
    row7.appendChild(turnCostToggle);
    row7.appendChild(menuLabel('自动关闭'));
    row7.appendChild(turnCostCloseInput);
    row7.appendChild(menuLabel('秒'));
    var row9 = menuRow();
    row9.appendChild(menuLabel('避让滚动条'));
    row9.appendChild(scrollGapToggle);
    row9.appendChild(menuLabel('宽度'));
    row9.appendChild(scrollGapInput);
    row9.appendChild(menuLabel('px'));
    var roleBtn = document.createElement('button');
    roleBtn.type = 'button';
    roleBtn.className = 'dshwv-rolebtn';
    roleBtn.title = '选择角色';
    var roleBtnThumb = document.createElement('img');
    roleBtnThumb.className = 'dshwv-rolebtn-thumb';
    roleBtnThumb.alt = '';
    roleBtnThumb.draggable = false;
    roleBtnThumb.src = initRoleUrl;
    var roleBtnLabel = document.createElement('span');
    roleBtnLabel.className = 'dshwv-btnlabel';
    roleBtnLabel.textContent = '小鲸鱼';
    roleBtn.appendChild(roleBtnThumb);
    roleBtn.appendChild(roleBtnLabel);
    var rolePanel = document.createElement('div');
    rolePanel.className = 'dshwv-rolelist';
    var roleImportBtn = document.createElement('button');
    roleImportBtn.type = 'button';
    roleImportBtn.className = 'dshwv-roleimport';
    roleImportBtn.textContent = '导入';
    roleImportBtn.title = '导入自定义角色图片';
    var rowRole = menuRow();
    rowRole.appendChild(menuLabel('角色'));
    rowRole.appendChild(roleBtn);
    rowRole.appendChild(roleImportBtn);
    var roleFileInput = document.createElement('input');
    roleFileInput.type = 'file';
    roleFileInput.accept = 'image/*';
    roleFileInput.style.display = 'none';
    roleBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleRolePanel();
    });
    roleImportBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      roleFileInput.click();
    });
    roleFileInput.addEventListener('change', function () {
      onRoleFileChosen(roleFileInput);
    });
    secLook.appendChild(rowRole);
    secLook.appendChild(row1);
    secSound.appendChild(row2);
    secSound.appendChild(row3);
    secBubble.appendChild(row6);
    var outcomeRow = menuRow();
    var failedNoticeToggle = document.createElement('input');
    failedNoticeToggle.type = 'checkbox'; failedNoticeToggle.className = 'dshwv-check';
    failedNoticeToggle.id = 'dshw-failed-notice'; failedNoticeToggle.checked = true;
    var cancelledNoticeToggle = document.createElement('input');
    cancelledNoticeToggle.type = 'checkbox'; cancelledNoticeToggle.className = 'dshwv-check';
    cancelledNoticeToggle.id = 'dshw-cancelled-notice'; cancelledNoticeToggle.checked = true;
    outcomeRow.appendChild(failedNoticeToggle); outcomeRow.appendChild(menuLabel('失败后显示扣费'));
    outcomeRow.appendChild(cancelledNoticeToggle); outcomeRow.appendChild(menuLabel('暂停／取消后显示扣费'));
    outcomeRow.title = '失败或暂停／取消时显示中性扣费提示（不播放成功音、不影响记账）；关闭后不再弹出这类气泡';
    function saveOutcomeNotice() {
      saveUsageSettings({ outcomeNotice: { failed: failedNoticeToggle.checked, cancelled: cancelledNoticeToggle.checked } });
    }
    failedNoticeToggle.addEventListener('change', saveOutcomeNotice);
    cancelledNoticeToggle.addEventListener('change', saveOutcomeNotice);
    // 额度管理's reminders page sets how completions are shown; these controls
    // keep the state the bubbles read.
    window.addEventListener('whale-notice-settings-request', function () {
      window.dispatchEvent(new CustomEvent('whale-notice-settings-state', { detail: { turnCostOn: turnCostOn, turnCostCloseMs: turnCostCloseMs,
        failed: failedNoticeToggle.checked, cancelled: cancelledNoticeToggle.checked } }));
    });
    window.addEventListener('whale-notice-settings', function (event) {
      var detail = event.detail || {};
      if (typeof detail.turnCostOn === 'boolean') setTurnCostOn(detail.turnCostOn);
      if (typeof detail.turnCostCloseMs === 'number') setTurnCostClose(detail.turnCostCloseMs / 1000);
      if (typeof detail.failed === 'boolean') failedNoticeToggle.checked = detail.failed;
      if (typeof detail.cancelled === 'boolean') cancelledNoticeToggle.checked = detail.cancelled;
      if (usageSet) usageSet.outcomeNotice = { failed: failedNoticeToggle.checked, cancelled: cancelledNoticeToggle.checked };
    });
    var rowTaskEnd = menuRow();
    rowTaskEnd.appendChild(menuLabel('任务结束'));
    rowTaskEnd.appendChild(taskEndToggle);
    rowTaskEnd.appendChild(taskEndSel);
    taskEndDrop = dshwCustSel(taskEndSel, { scrollNames: true });
    secSound.appendChild(rowTaskEnd);
    var rowApprovalSound = menuRow();
    rowApprovalSound.appendChild(menuLabel('审批提醒'));
    rowApprovalSound.appendChild(approvalSoundToggle);
    rowApprovalSound.appendChild(approvalSoundSel);
    approvalSoundDrop = dshwCustSel(approvalSoundSel, { scrollNames: true });
    secSound.appendChild(rowApprovalSound);
    var rowPomodoroSound = menuRow();
    rowPomodoroSound.appendChild(menuLabel('番茄钟'));
    rowPomodoroSound.appendChild(pomodoroSoundToggle);
    rowPomodoroSound.appendChild(pomodoroSoundSel);
    pomodoroSoundDrop = dshwCustSel(pomodoroSoundSel, { scrollNames: true });
    secSound.appendChild(rowPomodoroSound);
    var currencyRow = menuRow();
    currencyRow.appendChild(menuLabel('显示币种'));
    var currencySel = document.createElement('select');
    currencySel.id = 'dshw-display-currency';
    currencySel.className = 'dshwv-sound';
    [['', '原币种'], ['USD', '美元 USD'], ['CNY', '人民币 CNY']].forEach(function (entry) {
      var option = document.createElement('option');
      option.value = entry[0]; option.textContent = entry[1]; currencySel.appendChild(option);
    });
    currencyRow.appendChild(currencySel);
    var currencyDrop = dshwCustSel(currencySel);
    secBubble.appendChild(currencyRow);
    var currencyNote = document.createElement('div');
    currencyNote.className = 'dshwv-usage-hint';
    // 0.2.0: the long FX explanation moved behind the click-to-open "!" button on
    // the 参考汇率 row. Keep the node so currency text and existing automation
    // still resolve, but hide it from the panel.
    currencyNote.id = 'dshw-currency-note';
    currencyNote.style.whiteSpace = 'pre-line';
    currencyNote.hidden = true;
    currencyNote.style.display = 'none';
    secBubble.appendChild(currencyNote);
    var fxRefreshRow = menuRow();
    var fxInfoBtn = document.createElement('button');
    fxInfoBtn.type = 'button'; fxInfoBtn.className = 'dshwv-fxicon';
    fxInfoBtn.id = 'dshw-fx-info';
    fxInfoBtn.textContent = '!';
    fxInfoBtn.setAttribute('aria-label', '汇率说明');
    fxInfoBtn.setAttribute('aria-expanded', 'false');
    fxInfoBtn.title = '汇率说明';
    var fxInfoPanel = document.createElement('div');
    fxInfoPanel.className = 'dshwv-fxinfo';
    fxInfoPanel.id = 'dshw-fx-info-panel';
    fxInfoPanel.setAttribute('role', 'note');
    fxInfoPanel.style.whiteSpace = 'pre-line';
    fxInfoPanel.hidden = true;
    var fxInfoText = '';
    var fxInfoOpen = false;
    function placeFxInfo() {
      if (!fxInfoOpen) return;
      var r = fxInfoBtn.getBoundingClientRect();
      var vp = viewport();
      var w = fxInfoPanel.offsetWidth || 260;
      var h = fxInfoPanel.offsetHeight || 96;
      var left = Math.max(4, Math.min(r.right - w, vp.w - w - 4));
      var top = r.bottom + 4;
      if (top + h > vp.h - 4) top = Math.max(4, r.top - h - 4);
      fxInfoPanel.style.left = left + 'px';
      fxInfoPanel.style.top = top + 'px';
    }
    function positionFxInfo() {
      try { placeFxInfo(); } catch (err) {}
    }
    function setFxInfoOpen(open) {
      fxInfoOpen = !!open;
      if (open) {
        fxInfoPanel.hidden = false;
        if (fxInfoPanel.parentNode !== document.body) document.body.appendChild(fxInfoPanel);
        fxInfoPanel.textContent = fxInfoText || '正在获取参考汇率…';
        positionFxInfo();
      } else {
        fxInfoPanel.hidden = true;
        if (fxInfoPanel.parentNode === document.body) document.body.removeChild(fxInfoPanel);
      }
      fxInfoBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    function closeFxInfo() {
      if (!fxInfoOpen) return;
      setFxInfoOpen(false);
    }
    if (!window.__dshwFxInfoBound) {
      window.__dshwFxInfoBound = true;
      // Same dismissal contract as the other popovers: outside pointerdown or
      // Escape closes it. Clicks inside stay inside the panel.
      document.addEventListener('pointerdown', function (e) {
        if (!fxInfoOpen || !e.target || !e.target.closest) return;
        if (e.target.closest('.dshwv-fxinfo') || e.target.closest('.dshwv-fxicon')) return;
        closeFxInfo();
      }, true);
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') closeFxInfo();
      }, true);
      window.addEventListener('resize', closeFxInfo);
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(positionFxInfo);
    }
    fxInfoBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      setFxInfoOpen(!fxInfoOpen);
    });
    fxRefreshRow.appendChild(menuLabel('参考汇率'));
    fxRefreshRow.appendChild(fxInfoBtn);
    var fxRefreshBtn = document.createElement('button');
    fxRefreshBtn.type = 'button'; fxRefreshBtn.className = 'dshwv-roleimport';
    fxRefreshBtn.id = 'dshw-fx-refresh'; fxRefreshBtn.textContent = '刷新汇率';
    fxRefreshBtn.title = '立即检查 Frankfurter 汇率并更新金额文字；15 秒内避免重复请求';
    fxRefreshRow.appendChild(fxRefreshBtn); secBubble.appendChild(fxRefreshRow);
    function fxTime(value) {
      var date = new Date(value);
      return value && isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '尚未成功获取';
    }
    function updateFxButton() {
      var moneyState = WhaleMoney.state();
      var seconds = Math.ceil((moneyState.cooldownRemainingMs || 0) / 1000);
      fxRefreshBtn.disabled = !!moneyState.refreshing || seconds > 0;
      fxRefreshBtn.textContent = moneyState.refreshing ? '检查中…' : seconds > 0 ? seconds + ' 秒后刷新' : '刷新汇率';
    }
    fxRefreshBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      WhaleMoney.refreshQuote({ force: true, apply: true, reason: 'manual' }).then(function (ok) {
        assetNotice(ok ? '参考汇率已检查，金额显示已同步' : '本次汇率检查未成功，继续使用可用汇率');
      }).catch(function (error) { assetNotice(error.message); });
      updateFxButton();
    });
    setInterval(updateFxButton, 1000);
    WhaleMoney.onChange(function (moneyState) {
      currencySel.value = moneyState.displayCurrency || '';
      currencyDrop.refresh();
      var fx = moneyState.quote;
      var latest = moneyState.latestQuote || fx;
      currencyNote.textContent = (fx ? '1 美元 = ' + fx.usdCny + ' 人民币\nFrankfurter · 汇率日期 ' + fx.date : '正在获取参考汇率…') +
        (latest && latest.stale ? ' · 离线缓存' : '') +
        (!fx && moneyState.displayCurrency ? '\n还没有汇率，金额暂按各自的币种显示' : '') +
        '\n最近成功获取：' + fxTime(latest && latest.retrievedAt) +
        '\n最近检查：' + fxTime(moneyState.checkedAt) + '（北京时间）' +
        '\n每天 00:15 检查；休市日可能沿用上个交易日' +
        (moneyState.hasPendingQuote ? '\n新汇率已就绪，下次打开或切换气泡时应用' : '') +
        (moneyState.error ? '\n' + moneyState.error : '');
      currencyNote.title = latest ? (latest.source || 'Frankfurter') + '；API 原始金额和记账币种不变。手动刷新立即应用，自动刷新保留当前气泡快照。' : '';
      fxInfoText = currencyNote.textContent;
      if (fxInfoOpen) {
        fxInfoPanel.textContent = fxInfoText;
        positionFxInfo();
      }
      updateFxButton();
    });
    currencySel.addEventListener('change', function () {
      var next = currencySel.value;
      currencySel.value = WhaleMoney.state().displayCurrency || '';
      currencyDrop.refresh();
      closeFxInfo();
      WhaleMoney.setDisplayCurrency(next || null).then(function (converted) {
        if (!converted) assetNotice('还没有汇率，金额先按各自的币种显示，拿到汇率后自动换算');
      }).catch(function (error) { assetNotice(error.message); });
    });
    secDesk.appendChild(row9);
    // The task window lives in desktop/ui/agents.js; the menu only switches it.
    var agentsApi = window.WhaleAgents;
    if (agentsApi) {
      var agentsToggle = document.createElement('input');
      agentsToggle.type = 'checkbox';
      agentsToggle.className = 'dshwv-check';
      agentsToggle.checked = agentsApi.enabled();
      agentsToggle.title = '常驻的小窗：每个 Claude Code 和 Codex 会话一行，点一行跳到它的 Ghostty 标签';
      agentsToggle.addEventListener('change', function () { agentsApi.setEnabled(agentsToggle.checked); });
      window.addEventListener('whale-agents', function (e) { agentsToggle.checked = !!e.detail.on; });
      var rowAgents = menuRow();
      rowAgents.appendChild(menuLabel('任务小窗'));
      rowAgents.appendChild(agentsToggle);
      secDesk.appendChild(rowAgents);
    }
    var rowSnap = menuRow();
    var snapRowLabel = document.createElement('span');
    snapRowLabel.textContent = '吸附与翻转';
    var snapCustomBtn = document.createElement('button');
    snapCustomBtn.type = 'button';
    snapCustomBtn.className = 'dshwv-roleimport';
    snapCustomBtn.textContent = '自定义';
    snapCustomBtn.title = '自定义各边吸附区宽度与翻转线位置';
    snapCustomBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      openSnapModal();
    });
    rowSnap.appendChild(snapRowLabel);
    rowSnap.appendChild(snapCustomBtn);
    secDesk.appendChild(rowSnap);
    var menuHideToggle = document.createElement('input');
    menuHideToggle.type = 'checkbox';
    menuHideToggle.className = 'dshwv-check';
    menuHideToggle.checked = false;
    menuHideToggle.title = '启用后隐藏挂件上的菜单按钮;右键小鲸鱼可唤出菜单(位置不变)';
    menuHideToggle.addEventListener('change', function () {
      setMenuBtnHide(menuHideToggle.checked);
    });
    var rowHide = menuRow();
    rowHide.appendChild(menuLabel('隐藏菜单按钮'));
    rowHide.appendChild(menuHideToggle);
    secDesk.appendChild(rowHide);
    var rowRes = menuRow();
    var resOpenBtn = document.createElement('button');
    resOpenBtn.type = 'button';
    resOpenBtn.className = 'dshwv-roleimport';
    resOpenBtn.style.flex = '1';
    resOpenBtn.textContent = '管理';
    resOpenBtn.title = '集中管理当前导入插件的图片与音频资源';
    resOpenBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      openResManager();
    });
    rowRes.appendChild(menuLabel('资源管理'));
    rowRes.appendChild(resOpenBtn);
    secDesk.appendChild(rowRes);
    var usageSet = null;
    function loadUsageSettings(cb) {
      try {
        usageClient.settings().then(function (d) {
          if (d && d.ok && d.settings) usageSet = d.settings;
          if (cb) cb();
        }).catch(function () {
          if (cb) cb();
        });
      } catch (err) {
        if (cb) cb();
      }
    }
    function saveUsageSettings(patch) {
      try {
        usageClient.saveSettings(patch).then(function (d) {
          requireSaved(d);
          if (d && d.ok && d.settings) usageSet = d.settings;
        }).catch(assetFailure);
      } catch (err) { assetFailure(err); }
    }
    // 额度管理 and 会话设置 as two tiles, then the commands.
    var menuTiles = document.createElement('div');
    menuTiles.className = 'dshwv-menu-tiles';
    function menuTile(label, icon, action) {
      var tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'dshwv-tile';
      tile.appendChild(menuIcon(icon));
      tile.appendChild(menuLabel(label));
      tile.addEventListener('click', function (e) {
        e.stopPropagation();
        action();
      });
      menuTiles.appendChild(tile);
      return tile;
    }
    menuTile('额度管理', 'gauge', function () {
      window.dispatchEvent(new Event('whale-open-settings'));
    });
    menuTile('会话设置', 'chat', function () {
      closeMenu();
      window.dispatchEvent(new Event('whale-open-chat-settings'));
    });
    menuBox.appendChild(menuTiles);
    var menuCommands = document.createElement('div');
    menuCommands.className = 'dshwv-menu-cmds';
    function menuCommand(label, icon, action, parent) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'dshwv-cmd';
      button.appendChild(menuIcon(icon));
      button.appendChild(menuLabel(label));
      button.addEventListener('click', function (e) {
        e.stopPropagation();
        action(button);
      });
      (parent || menuCommands).appendChild(button);
      return button;
    }
    // The tray menu has these on Windows; on macOS the pet's menu is the only place.
    var commandsHere = !!(window.whaleDesktop && window.whaleDesktop.platform === 'darwin');
    if (commandsHere) menuCommand('刷新额度', 'refresh', function () { refresh(true); });
    menuCommand('查看额度记录', 'bars', openQuotaRecords);
    if (commandsHere) menuCommand('查看运行状态', 'pulse', function () {
      if (window.whaleDesktop && window.whaleDesktop.command) window.whaleDesktop.command('status').catch(function () {});
    });
    menuBox.appendChild(menuCommands);
    if (commandsHere) {
      var menuFoot = document.createElement('div');
      menuFoot.className = 'dshwv-menu-foot';
      menuCommand('停止当前挂件', 'power', function () {
        if (window.whaleDesktop && window.whaleDesktop.command) window.whaleDesktop.command('stop').catch(function () {});
      }, menuFoot).classList.add('dshwv-cmd-danger');
      menuBox.appendChild(menuFoot);
    }
    var resMaskEl = null;
    var resCardEl = null;
    function resMaskOpen() {
      try {
        if (!resMaskEl) {
          resMaskEl = document.createElement('div');
          resMaskEl.className = 'dshwv-resmask';
          resMaskEl.style.display = 'none';
          resCardEl = document.createElement('div');
          resCardEl.className = 'dshwv-usage-card dshwv-rescard';
          resMaskEl.appendChild(resCardEl);
          resMaskEl.addEventListener('click', function (e) {
            if (e.target === resMaskEl) resManagerClose();
          });
          document.body.appendChild(resMaskEl);
        }
        resManagerRender();
        resMaskEl.style.display = 'flex';
      } catch (err) {}
    }
    function resManagerClose() {
      try {
        if (resMaskEl) resMaskEl.style.display = 'none';
      } catch (err) {}
    }
    function openResManager() {
      resMaskOpen();
    }
    function resMkTag(text, built) {
      var t = document.createElement('span');
      t.className = 'dshwv-restag' + (built ? ' dshwv-restag-built' : '');
      t.textContent = text;
      return t;
    }
    function resImgRow(imgUrl, name, meta, rightEls) {
      var img = document.createElement('img');
      img.className = 'dshwv-resthum';
      img.src = imgUrl;
      img.alt = '';
      var main = document.createElement('div');
      main.className = 'dshwv-resmain';
      main.style.minWidth = '0';
      var nm = document.createElement('div');
      nm.className = 'dshwv-resnm';
      nm.textContent = name;
      main.appendChild(nm);
      if (meta) {
        var mt = document.createElement('div');
        mt.className = 'dshwv-resmeta';
        mt.textContent = meta;
        main.appendChild(mt);
      }
      var row = document.createElement('div');
      row.className = 'dshwv-resrow';
      var left = document.createElement('div');
      left.className = 'dshwv-resmain';
      left.style.display = 'flex';
      left.style.alignItems = 'center';
      left.style.gap = '8px';
      left.appendChild(img);
      left.appendChild(main);
      row.appendChild(left);
      for (var i = 0; i < (rightEls || []).length; i++) row.appendChild(rightEls[i]);
      return row;
    }
    function resIconRow(iconText, name, meta, rightEls) {
      var icon = document.createElement('div');
      icon.className = 'dshwv-resicon';
      icon.textContent = iconText;
      var main = document.createElement('div');
      main.className = 'dshwv-resmain';
      main.style.minWidth = '0';
      var nm = document.createElement('div');
      nm.className = 'dshwv-resnm';
      nm.textContent = name;
      main.appendChild(nm);
      if (meta) {
        var mt = document.createElement('div');
        mt.className = 'dshwv-resmeta';
        mt.textContent = meta;
        main.appendChild(mt);
      }
      var row = document.createElement('div');
      row.className = 'dshwv-resrow';
      var left = document.createElement('div');
      left.className = 'dshwv-resmain';
      left.style.display = 'flex';
      left.style.alignItems = 'center';
      left.style.gap = '8px';
      left.appendChild(icon);
      left.appendChild(main);
      row.appendChild(left);
      for (var i = 0; i < (rightEls || []).length; i++) row.appendChild(rightEls[i]);
      return row;
    }
    function resMkDel(label, disabled, fn) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'dshwv-resdel';
      b.textContent = label;
      b.disabled = !!disabled;
      if (!disabled) b.addEventListener('click', function (e) {
        e.stopPropagation();
        fn();
      });
      return b;
    }
    function resManagerRender() {
      try {
        var card = resCardEl;
        card.innerHTML = '';
        var head = document.createElement('div');
        head.className = 'dshwv-reshead';
        var title = document.createElement('span');
        title.className = 'dshwv-restitle';
        title.textContent = '资源管理';
        var x = document.createElement('button');
        x.type = 'button';
        x.className = 'dshwv-resclose';
        x.textContent = '✕';
        x.title = '关闭';
        x.addEventListener('click', resManagerClose);
        head.appendChild(title);
        head.appendChild(x);
        card.appendChild(head);
        var wrap = document.createElement('div');
        wrap.className = 'dshwv-reswrap';
        card.appendChild(wrap);
        wrap.innerHTML = '<div class="dshwv-resempty">加载中…</div>';
        var roles = [];
        var audio = null;
        var done = 0;
        function fin() {
          done++;
          if (done < 2) return;
          resRenderData(wrap, roles, audio);
        }
        function fail() {
          fin();
        }
        try {
          fetch('/dsh-whale/roles.json', {
            cache: 'no-store'
          }).then(function (r) {
            return r.json();
          }).then(function (d) {
            if (d && d.ok && Array.isArray(d.roles)) roles = d.roles;
            fin();
          }).catch(fail);
        } catch (err) {
          fin();
        }
        try {
          fetch('/dsh-whale/audio.json', {
            cache: 'no-store'
          }).then(function (r) {
            return r.json();
          }).then(function (d) {
            audio = d;
            fin();
          }).catch(fail);
        } catch (err) {
          fin();
        }
      } catch (err) {}
    }
    function resDelRole(id) {
      var r = null;
      for (var i = 0; i < roleList.length; i++) if (roleList[i].id === id) {
        r = roleList[i];
        break;
      }
      showConfirm('确定删除角色「' + (r ? r.name : id) + '」吗？\n若该角色正被使用,将自动回退默认小鲸鱼。', function () {
        try {
          fetch('/dsh-whale/role-delete.json', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              id: id
            })
          }).then(function (res) {
            return res.json();
          }).then(function (d) {
          requireSaved(d);
            if (d && d.ok && Array.isArray(d.roles)) {
              roleList = d.roles;
              renderRolePanel();
              if (currentRole && currentRole.id === id) applyRole('default', '小鲸鱼', IMG_URL);
              openResManager();
            }
          }).catch(assetFailure);
        } catch (err) { assetFailure(err); }
      });
    }
    function resDelAudioGroup(id) {
      var g = null;
      for (var i = 0; i < (audioGroups || []).length; i++) if (audioGroups[i].id === id) {
        g = audioGroups[i];
        break;
      }
      showConfirm('确定删除音效组「' + (g && g.name ? g.name : id) + '」吗？', function () {
        try {
          fetch('/dsh-whale/audio.json', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              action: 'delete-group',
              id: id
            })
          }).then(function (r) {
            return r.json();
          }).then(function (d) {
          requireSaved(d);
            if (d && d.ok && Array.isArray(d.groups)) {
              audioGroups = d.groups;
              renderAudioGroupPanel();
              refreshTaskEndAfterAudio();
              if (soundSet === id) setSoundSet('duck');
              openResManager();
            }
          }).catch(assetFailure);
        } catch (err) { assetFailure(err); }
      });
    }
    function resDelAudioFrag(id) {
      var f = null;
      for (var i = 0; i < (audioFragments || []).length; i++) if (audioFragments[i].id === id) {
        f = audioFragments[i];
        break;
      }
      showConfirm('确定删除音频片段「' + (f && f.name ? f.name : id) + '」吗？\n引用该片段的音效组槽位会自动回退预设。', function () {
        try {
          fetch('/dsh-whale/audio.json', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              action: 'delete-fragment',
              id: id
            })
          }).then(function (r) {
            return r.json();
          }).then(function (d) {
          requireSaved(d);
            if (d && d.ok && Array.isArray(d.fragments)) {
              audioFragments = d.fragments;
              if (Array.isArray(d.groups)) audioGroups = d.groups;
              renderAudioGroupPanel();
              refreshTaskEndAfterAudio();
              openResManager();
            }
          }).catch(assetFailure);
        } catch (err) { assetFailure(err); }
      });
    }
    function resRenderData(wrap, roles, audio) {
      try {
        wrap.innerHTML = '';
        var catImg = document.createElement('div');
        catImg.className = 'dshwv-rescat';
        catImg.textContent = '图片';
        wrap.appendChild(catImg);
        var anyImg = false;
        roles.forEach(function (r) {
          anyImg = true;
          var isDefault = r.id === 'default';
          var tag = resMkTag(isDefault ? '默认角色' : '自定义角色', isDefault);
          wrap.appendChild(resImgRow(r.url, r.name || r.id, r.id, [tag, resMkDel('删除', isDefault, function () {
            resDelRole(r.id);
          })]));
        });
        if (!anyImg) {
          var empty = document.createElement('div');
          empty.className = 'dshwv-resempty';
          empty.textContent = '暂无自定义角色图片';
          wrap.appendChild(empty);
        }
        var catAu = document.createElement('div');
        catAu.className = 'dshwv-rescat';
        catAu.textContent = '音频';
        wrap.appendChild(catAu);
        var anyAu = false;
        var groups = audio && Array.isArray(audio.groups) ? audio.groups : [];
        groups.forEach(function (g) {
          anyAu = true;
          var preset = !!g.preset;
          var tag = resMkTag(preset ? '预设组' : '自定义组', preset);
          var meta = '';
          if (!preset && g.press && g.release) meta = '按压:' + g.press + ' 松开:' + g.release;
          wrap.appendChild(resIconRow(preset ? '🎧' : '🎵', g.name || g.id, meta, [tag, resMkDel('删除', preset, function () {
            resDelAudioGroup(g.id);
          })]));
        });
        var frags = audio && Array.isArray(audio.fragments) ? audio.fragments : [];
        frags.forEach(function (f) {
          if (f.preset) return;
          anyAu = true;
          var tag = resMkTag('音频片段', false);
          wrap.appendChild(resIconRow('🎶', f.name || f.id, f.id, [tag, resMkDel('删除', false, function () {
            resDelAudioFrag(f.id);
          })]));
        });
        if (!anyAu) {
          var empty2 = document.createElement('div');
          empty2.className = 'dshwv-resempty';
          empty2.textContent = '暂无自定义音频(片段/音效组)';
          wrap.appendChild(empty2);
        }
      } catch (err) {}
    }
    var SNAP_PREVIEW = 190;
    var snapPvW = SNAP_PREVIEW;
    var snapPvH = SNAP_PREVIEW;
    var snapEdit = null;
    var snapLineDrag = null;
    var snapMask = null;
    var snapCard = null;
    var snapRadio = {};
    var snapNum = {};
    var snapNumUnit = {};
    var snapPreview = null;
    function unitOf(mode) {
      return mode === 'px' ? 'px' : '%';
    }
    function ensureSnapPx(cfg) {
      try {
        if (!(cfg.px.F >= 0)) {
          cfg.px.L = 80;
          cfg.px.T = 0;
          cfg.px.R = 80;
          cfg.px.B = 80;
          cfg.px.F = Math.round(Math.max(1, viewport().w) / 2);
        }
      } catch (err) {}
    }
    function snapSetVal(key, val) {
      try {
        if (!snapEdit || snapEdit.mode === 'off') return;
        var m = snapEdit.mode;
        var vp = viewport();
        var set = m === 'px' ? snapEdit.px : snapEdit.ratio;
        var clamped = clampSnapKey(m, key, val, vp);
        set[key] = Math.max(0, Math.round(clamped));
      } catch (err) {}
    }
    function snapPvSize() {
      var vp = viewport();
      var maxW = 210, maxH = 190, minSide = 56;
      var ar = Math.max(0.05, vp.w / vp.h);
      var w, h;
      if (ar * maxH <= maxW) {
        h = maxH;
        w = maxH * ar;
      } else {
        w = maxW;
        h = maxW / ar;
      }
      w = Math.round(Math.max(minSide, Math.min(maxW, w)));
      h = Math.round(Math.max(minSide, Math.min(maxH, h)));
      return {
        w: w,
        h: h
      };
    }
    function snapFrac() {
      var vp = viewport();
      var f = {
        Lf: 0,
        Tf: 0,
        Rf: 1,
        Bf: 1,
        Ff: 0.5
      };
      try {
        var m = snapEdit.mode;
        var w = Math.max(1, vp.w), h = Math.max(1, vp.h);
        if (m === 'ratio') {
          f.Lf = Math.min(100, Math.max(0, snapEdit.ratio.L)) / 100;
          f.Tf = Math.min(100, Math.max(0, snapEdit.ratio.T)) / 100;
          f.Rf = 1 - Math.min(100, Math.max(0, snapEdit.ratio.R)) / 100;
          f.Bf = 1 - Math.min(100, Math.max(0, snapEdit.ratio.B)) / 100;
          f.Ff = Math.min(100, Math.max(0, snapEdit.ratio.F)) / 100;
        } else if (m === 'px') {
          f.Lf = Math.min(w, Math.max(0, snapEdit.px.L)) / w;
          f.Tf = Math.min(h, Math.max(0, snapEdit.px.T)) / h;
          f.Rf = 1 - Math.min(w, Math.max(0, snapEdit.px.R)) / w;
          f.Bf = 1 - Math.min(h, Math.max(0, snapEdit.px.B)) / h;
          f.Ff = Math.min(w, Math.max(0, snapEdit.px.F)) / w;
        }
      } catch (err) {}
      return f;
    }
    function renderSnapPreview() {
      try {
        if (!snapEdit || !snapPreview) return;
        snapPreview.innerHTML = '';
        var W = snapPvW;
        var H = snapPvH;
        if (snapEdit.mode === 'off') {
          var off = document.createElement('div');
          off.className = 'dshwv-snapoff';
          off.textContent = '已关闭：无吸附、无翻转，自由摆放';
          snapPreview.appendChild(off);
          return;
        }
        var f = snapFrac();
        var Lx = Math.max(0, Math.min(W, f.Lf * W));
        var Rx = Math.max(0, Math.min(W, f.Rf * W));
        var Ty = Math.max(0, Math.min(H, f.Tf * H));
        var By = Math.max(0, Math.min(H, f.Bf * H));
        var Fx = Math.max(0, Math.min(W, f.Ff * W));
        var flipBg = document.createElement('div');
        flipBg.className = 'dshwv-snapflip';
        flipBg.style.width = Fx + 'px';
        flipBg.style.height = H + 'px';
        snapPreview.appendChild(flipBg);
        var zoneDefs = [{
          l: 0,
          t: 0,
          w: Lx,
          h: H,
          bg: 'rgba(59,130,246,.20)'
        }, {
          l: Rx,
          t: 0,
          w: Math.max(0, W - Rx),
          h: H,
          bg: 'rgba(245,158,11,.18)'
        }, {
          l: 0,
          t: 0,
          w: W,
          h: Ty,
          bg: 'rgba(16,185,129,.16)'
        }, {
          l: 0,
          t: By,
          w: W,
          h: Math.max(0, H - By),
          bg: 'rgba(239,68,68,.14)'
        }];
        var i, zd;
        for (i = 0; i < zoneDefs.length; i++) {
          zd = zoneDefs[i];
          if (zd.w < 1 || zd.h < 1) continue;
          var z = document.createElement('div');
          z.className = 'dshwv-snapzone';
          z.style.left = zd.l + 'px';
          z.style.top = zd.t + 'px';
          z.style.width = zd.w + 'px';
          z.style.height = zd.h + 'px';
          z.style.background = zd.bg;
          snapPreview.appendChild(z);
        }
        var lineDefs = [{
          key: 'L',
          x: Lx,
          horizontal: false,
          flip: false
        }, {
          key: 'R',
          x: Rx,
          horizontal: false,
          flip: false
        }, {
          key: 'T',
          y: Ty,
          horizontal: true,
          flip: false
        }, {
          key: 'B',
          y: By,
          horizontal: true,
          flip: false
        }, {
          key: 'F',
          x: Fx,
          horizontal: false,
          flip: true
        }];
        for (i = 0; i < lineDefs.length; i++) {
          var ld = lineDefs[i];
          var p = ld.horizontal ? Math.max(0, Math.min(H, ld.y)) : Math.max(0, Math.min(W, ld.x));
          var ln = document.createElement('div');
          ln.className = 'dshwv-snapline' + (ld.flip ? ' dshwv-snapline-flip' : '');
          if (ld.horizontal) {
            ln.style.left = '0px';
            ln.style.top = p + 'px';
            ln.style.width = W + 'px';
            ln.style.height = '2px';
          } else {
            ln.style.left = p + 'px';
            ln.style.top = '0px';
            ln.style.width = '2px';
            ln.style.height = H + 'px';
          }
          snapPreview.appendChild(ln);
          var hd = document.createElement('div');
          hd.className = 'dshwv-snaphandle' + (ld.flip ? ' dshwv-snaphandle-flip' : '') + (ld.horizontal ? ' dshwv-snaphandle-h' : '');
          hd.style.left = (ld.horizontal ? W / 2 : p) + 'px';
          hd.style.top = (ld.horizontal ? p : H / 2) + 'px';
          hd.title = ld.key === 'F' ? '翻转线（左侧为翻转区）' : '吸附区边界线（可拖动）';
          hd.addEventListener('pointerdown', (function (key, horizontal) {
            return function (e) {
              startSnapLineDrag(e, key, horizontal);
            };
          })(ld.key, ld.horizontal));
          snapPreview.appendChild(hd);
        }
      } catch (err) {}
    }
    function syncSnapInputs() {
      try {
        if (!snapEdit) return;
        var m = snapEdit.mode;
        var set = m === 'px' ? snapEdit.px : snapEdit.ratio;
        var keys = ['L', 'T', 'R', 'B', 'F'];
        var unit = unitOf(m);
        var i;
        for (i = 0; i < keys.length; i++) {
          var k = keys[i];
          snapNum[k].value = String(Math.round(set[k]));
          snapNum[k].disabled = m === 'off';
          snapNumUnit[k].textContent = unit;
        }
      } catch (err) {}
    }
    function renderSnapModes() {
      try {
        if (snapEdit && snapRadio[snapEdit.mode]) snapRadio[snapEdit.mode].checked = true;
      } catch (err) {}
    }
    function startSnapLineDrag(e, key, horizontal) {
      try {
        e.preventDefault();
        try {
          e.stopPropagation();
        } catch (err) {}
        if (!snapEdit || snapEdit.mode === 'off') return;
        var vp = viewport();
        var axis = horizontal ? vp.h : vp.w;
        var domain = snapEdit.mode === 'px' ? axis : 100;
        var set = snapEdit.mode === 'px' ? snapEdit.px : snapEdit.ratio;
        snapLineDrag = {
          key: key,
          horizontal: horizontal,
          sx: e.clientX,
          sy: e.clientY,
          factor: domain / (horizontal ? Math.max(1, snapPvH) : Math.max(1, snapPvW)),
          orig: set[key]
        };
        document.addEventListener('pointermove', onSnapLineMove, true);
        document.addEventListener('pointerup', onSnapLineUp, true);
        document.addEventListener('pointercancel', onSnapLineUp, true);
      } catch (err) {}
    }
    function onSnapLineMove(e) {
      try {
        if (!snapLineDrag) return;
        var d = snapLineDrag;
        var delta = d.horizontal ? e.clientY - d.sy : e.clientX - d.sx;
        var val;
        if (d.key === 'R' || d.key === 'B') val = d.orig - delta * d.factor; else val = d.orig + delta * d.factor;
        snapSetVal(d.key, val);
        renderSnapPreview();
        syncSnapInputs();
      } catch (err) {}
    }
    function onSnapLineUp() {
      try {
        snapLineDrag = null;
        document.removeEventListener('pointermove', onSnapLineMove, true);
        document.removeEventListener('pointerup', onSnapLineUp, true);
        document.removeEventListener('pointercancel', onSnapLineUp, true);
      } catch (err) {}
    }
    function onSnapNumInput(key) {
      try {
        var v = Number(snapNum[key].value);
        if (!isFinite(v)) return;
        snapSetVal(key, v);
        renderSnapPreview();
        syncSnapInputs();
      } catch (err) {}
    }
    function resetSnapEdit() {
      try {
        if (!snapEdit) return;
        var m = snapEdit.mode;
        if (m === 'ratio') {
          snapEdit.ratio = {
            L: 10,
            T: 0,
            R: 10,
            B: 15,
            F: 50
          };
        } else if (m === 'px') {
          snapEdit.px = {
            L: 80,
            T: 0,
            R: 80,
            B: 80,
            F: Math.round(Math.max(1, viewport().w) / 2)
          };
        }
        renderSnapModes();
        renderSnapPreview();
        syncSnapInputs();
      } catch (err) {}
    }
    function openSnapModal() {
      try {
        closeRolePanel();
        closeAudioGroupPanel();
        var sz = snapPvSize();
        snapPvW = sz.w;
        snapPvH = sz.h;
        if (snapPreview) {
          snapPreview.style.width = snapPvW + 'px';
          snapPreview.style.height = snapPvH + 'px';
        }
        if (snapGrid) {
          snapGrid.style.gridTemplateColumns = '72px ' + snapPvW + 'px 72px';
          snapGrid.style.gridTemplateRows = '26px ' + snapPvH + 'px 26px';
        }
        snapEdit = cloneSnap(snapConfig);
        ensureSnapPx(snapEdit);
        renderSnapModes();
        renderSnapPreview();
        syncSnapInputs();
        snapMask.style.display = 'flex';
      } catch (err) {}
    }
    function closeSnapModal(apply) {
      try {
        if (apply && snapEdit) {
          snapConfig = cloneSnap(snapEdit);
          fixSnapConfig(snapConfig);
          saveSnapConfig();
          applySnapConfigNow();
        }
        snapEdit = null;
        snapMask.style.display = 'none';
      } catch (err) {}
    }
    function applySnapConfigNow() {
      try {
        if (snapConfig.mode === 'off') {
          state.flip = false;
          express();
          return;
        }
        snapCheck();
      } catch (err) {}
    }
    snapMask = document.createElement('div');
    snapMask.className = 'dshwv-snapmask';
    snapMask.style.display = 'none';
    snapCard = document.createElement('div');
    snapCard.className = 'dshwv-snapwin';
    var snapTitle = document.createElement('div');
    snapTitle.className = 'dshwv-snaptitle';
    snapTitle.textContent = '吸附与翻转设置';
    snapCard.appendChild(snapTitle);
    var snapModes = document.createElement('div');
    snapModes.className = 'dshwv-snapmodes';
    var snapModeDefs = [['ratio', '比例吸附'], ['px', '绝对吸附'], ['off', '关闭']];
    var mi;
    for (mi = 0; mi < snapModeDefs.length; mi++) {
      (function (k, label) {
        var lab = document.createElement('label');
        var inp = document.createElement('input');
        inp.type = 'radio';
        inp.name = 'dshwv-snapmode';
        inp.value = k;
        inp.addEventListener('change', function () {
          if (!snapEdit) return;
          snapEdit.mode = k;
          if (k === 'px') ensureSnapPx(snapEdit);
          renderSnapModes();
          renderSnapPreview();
          syncSnapInputs();
        });
        var tx = document.createElement('span');
        tx.textContent = label;
        lab.appendChild(inp);
        lab.appendChild(tx);
        snapModes.appendChild(lab);
        snapRadio[k] = inp;
      })(snapModeDefs[mi][0], snapModeDefs[mi][1]);
    }
    snapCard.appendChild(snapModes);
    var snapGrid = document.createElement('div');
    snapGrid.className = 'dshwv-snapgrid';
    function snapMakeNum(key, labelText) {
      var cell = document.createElement('span');
      cell.className = 'dshwv-snapcell';
      var inp = document.createElement('input');
      inp.type = 'number';
      inp.min = '0';
      inp.step = '1';
      inp.className = 'dshwv-snapnum';
      inp.title = labelText;
      inp.addEventListener('input', function () {
        onSnapNumInput(key);
      });
      inp.addEventListener('change', function () {
        onSnapNumInput(key);
      });
      var un = document.createElement('span');
      un.className = 'dshwv-snapunit';
      un.textContent = '%';
      cell.appendChild(inp);
      cell.appendChild(un);
      snapNum[key] = inp;
      snapNumUnit[key] = un;
      return cell;
    }
    snapPreview = document.createElement('div');
    snapPreview.className = 'dshwv-snappreview';
    var snapGridT = document.createElement('div');
    snapGridT.className = 'dshwv-snapcell';
    snapGridT.style.gridColumn = '2';
    snapGridT.style.gridRow = '1';
    snapGridT.appendChild(snapMakeNum('T', '上侧吸附区：距屏幕顶部的宽度'));
    var snapGridL = document.createElement('div');
    snapGridL.className = 'dshwv-snapcell';
    snapGridL.style.gridColumn = '1';
    snapGridL.style.gridRow = '2';
    snapGridL.appendChild(snapMakeNum('L', '左侧吸附区：距屏幕左边的宽度'));
    var snapGridC = document.createElement('div');
    snapGridC.style.gridColumn = '2';
    snapGridC.style.gridRow = '2';
    snapGridC.style.lineHeight = '0';
    snapGridC.appendChild(snapPreview);
    var snapGridR = document.createElement('div');
    snapGridR.className = 'dshwv-snapcell';
    snapGridR.style.gridColumn = '3';
    snapGridR.style.gridRow = '2';
    snapGridR.appendChild(snapMakeNum('R', '右侧吸附区：距屏幕右边的宽度'));
    var snapGridB = document.createElement('div');
    snapGridB.className = 'dshwv-snapcell';
    snapGridB.style.gridColumn = '2';
    snapGridB.style.gridRow = '3';
    snapGridB.appendChild(snapMakeNum('B', '下侧吸附区：距屏幕底部的宽度'));
    snapGrid.appendChild(snapGridT);
    snapGrid.appendChild(snapGridL);
    snapGrid.appendChild(snapGridC);
    snapGrid.appendChild(snapGridR);
    snapGrid.appendChild(snapGridB);
    snapCard.appendChild(snapGrid);
    var snapFlipRow = document.createElement('div');
    snapFlipRow.className = 'dshwv-snapfliprow';
    var snapFlipLabel = document.createElement('span');
    snapFlipLabel.textContent = '翻转线';
    snapFlipRow.appendChild(snapFlipLabel);
    snapFlipRow.appendChild(snapMakeNum('F', '翻转线：距屏幕左边的位置，线左侧的鲸鱼会左右翻转'));
    snapCard.appendChild(snapFlipRow);
    var snapBtns = document.createElement('div');
    snapBtns.className = 'dshwv-snapbtns';
    function snapBtn(label, cls, fn) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'dshwv-snapbtn ' + cls;
      b.textContent = label;
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        fn();
      });
      return b;
    }
    snapBtns.appendChild(snapBtn('取消', 'dshwv-snapbtn-no', function () {
      closeSnapModal(false);
    }));
    snapBtns.appendChild(snapBtn('重置', 'dshwv-snapbtn-no', resetSnapEdit));
    snapBtns.appendChild(snapBtn('确认', 'dshwv-snapbtn-ok', function () {
      closeSnapModal(true);
    }));
    snapCard.appendChild(snapBtns);
    snapMask.appendChild(snapCard);
    document.body.appendChild(snapMask);
    // A dropdown list opens under its button, or above it when the screen ends first.
    function dshwDropOpen(menuEl, anchorEl) {
      try {
        if (menuEl.parentNode !== document.body) document.body.appendChild(menuEl);
        menuEl.style.position = 'fixed';
        menuEl.style.minWidth = '0px';
        menuEl.style.left = '0px';
        menuEl.style.top = '0px';
        menuEl.classList.add('dshwv-rgbopen');
        var r = anchorEl.getBoundingClientRect();
        var vp = viewport();
        var w = Math.min(Math.max(20, Math.round(r.width)), Math.max(20, vp.w - 16));
        menuEl.style.width = w + 'px';
        menuEl.style.maxWidth = 'none';
        menuEl.style.left = Math.round(Math.min(r.left, Math.max(8, vp.w - w - 8))) + 'px';
        var h = menuEl.offsetHeight;
        var below = r.bottom + 4 + h <= vp.h - 8 || r.top - 4 - h < 8;
        menuEl.style.top = Math.round(below ? r.bottom + 4 : r.top - 4 - h) + 'px';
        menuEl.style.zIndex = '26010';
      } catch (err) {}
    }
    var CROP_BOX = 260;
    var cropMask = document.createElement('div');
    cropMask.className = 'dshwv-cropmask';
    cropMask.style.display = 'none';
    var cropCard = document.createElement('div');
    cropCard.className = 'dshwv-cropwin';
    var cropTitle = document.createElement('div');
    cropTitle.className = 'dshwv-croptitle';
    cropTitle.textContent = '裁剪角色图片';
    var cropBox = document.createElement('div');
    cropBox.className = 'dshwv-cropbox';
    var cropCanvas = document.createElement('canvas');
    cropCanvas.width = CROP_BOX;
    cropCanvas.height = CROP_BOX;
    cropBox.appendChild(cropCanvas);
    var cropZoom = document.createElement('input');
    cropZoom.type = 'range';
    cropZoom.min = '0.3';
    cropZoom.max = '3';
    cropZoom.step = '0.01';
    cropZoom.value = '1';
    cropZoom.className = 'dshwv-cropzoom';
    var cropZoomWrap = document.createElement('div');
    cropZoomWrap.className = 'dshwv-cropctrl';
    var cropZoomLabel = document.createElement('span');
    cropZoomLabel.className = 'dshwv-croplabel';
    cropZoomLabel.textContent = '缩放';
    var cropZoomNum = document.createElement('input');
    cropZoomNum.type = 'number';
    cropZoomNum.min = '30';
    cropZoomNum.max = '300';
    cropZoomNum.step = '1';
    cropZoomNum.value = '100';
    cropZoomNum.className = 'dshwv-cropnum';
    cropZoomWrap.appendChild(cropZoomLabel);
    cropZoomWrap.appendChild(cropZoom);
    cropZoomWrap.appendChild(cropZoomNum);
    var cropNameInput = document.createElement('input');
    cropNameInput.type = 'text';
    cropNameInput.className = 'dshwv-cropname';
    cropNameInput.maxLength = 16;
    cropNameInput.placeholder = '角色名称';
    var cropAngleWrap = document.createElement('div');
    cropAngleWrap.className = 'dshwv-cropctrl';
    var cropAngleLabel = document.createElement('span');
    cropAngleLabel.className = 'dshwv-croplabel';
    cropAngleLabel.textContent = '旋转';
    var cropFlipHBtn = document.createElement('button');
    cropFlipHBtn.type = 'button';
    cropFlipHBtn.className = 'dshwv-cropflip';
    cropFlipHBtn.textContent = '⇋';
    cropFlipHBtn.title = '水平翻转';
    var cropFlipVBtn = document.createElement('button');
    cropFlipVBtn.type = 'button';
    cropFlipVBtn.className = 'dshwv-cropflip';
    cropFlipVBtn.textContent = '⇅';
    cropFlipVBtn.title = '垂直翻转';
    var cropAngle = document.createElement('input');
    cropAngle.type = 'range';
    cropAngle.min = '-360';
    cropAngle.max = '360';
    cropAngle.step = '1';
    cropAngle.value = '0';
    cropAngle.className = 'dshwv-cropzoom';
    var cropAngleNum = document.createElement('input');
    cropAngleNum.type = 'number';
    cropAngleNum.min = '-360';
    cropAngleNum.max = '360';
    cropAngleNum.step = '1';
    cropAngleNum.value = '0';
    cropAngleNum.className = 'dshwv-cropnum';
    cropAngleWrap.appendChild(cropAngleLabel);
    cropAngleWrap.appendChild(cropFlipHBtn);
    cropAngleWrap.appendChild(cropFlipVBtn);
    cropAngleWrap.appendChild(cropAngle);
    cropAngleWrap.appendChild(cropAngleNum);
    var cropBtns = document.createElement('div');
    cropBtns.className = 'dshwv-cropbtns';
    var cropCancelBtn = document.createElement('button');
    cropCancelBtn.type = 'button';
    cropCancelBtn.className = 'dshwv-cropbtn dshwv-cropbtn-no';
    cropCancelBtn.textContent = '取消';
    var cropResetBtn = document.createElement('button');
    cropResetBtn.type = 'button';
    cropResetBtn.className = 'dshwv-cropbtn dshwv-cropbtn-no';
    cropResetBtn.textContent = '重置';
    cropResetBtn.title = '重置缩放、旋转和位置';
    var cropOkBtn = document.createElement('button');
    cropOkBtn.type = 'button';
    cropOkBtn.className = 'dshwv-cropbtn dshwv-cropbtn-ok';
    cropOkBtn.textContent = '确认';
    cropBtns.appendChild(cropCancelBtn);
    cropBtns.appendChild(cropResetBtn);
    cropBtns.appendChild(cropOkBtn);
    cropCard.appendChild(cropTitle);
    cropCard.appendChild(cropBox);
    cropCard.appendChild(cropNameInput);
    cropCard.appendChild(cropZoomWrap);
    cropCard.appendChild(cropAngleWrap);
    cropCard.appendChild(cropBtns);
    cropMask.appendChild(cropCard);
    document.body.appendChild(cropMask);
    cropBox.addEventListener('pointerdown', onCropDown);
    cropBox.addEventListener('pointermove', onCropMove);
    cropBox.addEventListener('pointerup', onCropUp);
    cropBox.addEventListener('pointercancel', onCropUp);
    cropBox.addEventListener('pointerleave', onCropUp);
    cropBox.addEventListener('wheel', onCropWheel, {
      passive: false
    });
    cropAngle.addEventListener('input', function () {
      if (cropState) {
        cropState.rotation = clampAngle(Number(cropAngle.value));
        cropAngleNum.value = String(cropState.rotation);
        positionCrop();
      }
    });
    cropAngleNum.addEventListener('input', function () {
      if (cropState) {
        var v = Math.round(Number(cropAngleNum.value));
        if (!isFinite(v)) v = 0;
        cropState.rotation = clampAngle(v);
        cropAngle.value = String(cropState.rotation);
        positionCrop();
      }
    });
    cropAngleNum.addEventListener('change', function () {
      if (cropState) cropAngleNum.value = String(cropState.rotation);
    });
    cropZoom.addEventListener('input', function () {
      if (cropState) {
        cropState.zoom = Number(cropZoom.value);
        cropZoomNum.value = String(Math.round(cropState.zoom * 100));
        positionCrop();
      }
    });
    cropZoomNum.addEventListener('input', function () {
      if (cropState) {
        var pct = Number(cropZoomNum.value);
        if (!isFinite(pct)) pct = 100;
        cropState.zoom = Math.min(3, Math.max(0.3, pct / 100));
        cropZoom.value = String(cropState.zoom);
        positionCrop();
      }
    });
    cropZoomNum.addEventListener('change', function () {
      if (cropState) cropZoomNum.value = String(Math.round(cropState.zoom * 100));
    });
    cropCancelBtn.addEventListener('click', function () {
      hideCropModal();
    });
    cropResetBtn.addEventListener('click', function () {
      resetCrop();
    });
    cropOkBtn.addEventListener('click', function () {
      confirmCrop();
    });
    cropFlipHBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      flipCrop('H');
    });
    cropFlipVBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      flipCrop('V');
    });
    var gifMask = document.createElement('div');
    gifMask.className = 'dshwv-gifmask';
    gifMask.style.display = 'none';
    var gifCard = document.createElement('div');
    gifCard.className = 'dshwv-gifwin';
    var gifTitle = document.createElement('div');
    gifTitle.className = 'dshwv-giftitle';
    gifTitle.textContent = '导入动图角色';
    var gifPreviewBox = document.createElement('div');
    gifPreviewBox.className = 'dshwv-gifpreview';
    var gifPreviewImg = document.createElement('img');
    gifPreviewImg.className = 'dshwv-gifpreviewimg';
    gifPreviewImg.alt = '动图预览';
    gifPreviewImg.draggable = false;
    gifPreviewBox.appendChild(gifPreviewImg);
    var gifHint = document.createElement('div');
    gifHint.className = 'dshwv-gifhint';
    gifHint.textContent = 'GIF 动图不支持裁剪，将按原始尺寸原样导入';
    var gifNameInput = document.createElement('input');
    gifNameInput.type = 'text';
    gifNameInput.className = 'dshwv-gifname';
    gifNameInput.maxLength = 16;
    gifNameInput.placeholder = '角色名称';
    var gifBtns = document.createElement('div');
    gifBtns.className = 'dshwv-cropbtns';
    var gifCancelBtn = document.createElement('button');
    gifCancelBtn.type = 'button';
    gifCancelBtn.className = 'dshwv-cropbtn dshwv-cropbtn-no';
    gifCancelBtn.textContent = '取消';
    var gifOkBtn = document.createElement('button');
    gifOkBtn.type = 'button';
    gifOkBtn.className = 'dshwv-cropbtn dshwv-cropbtn-ok';
    gifOkBtn.textContent = '确认';
    gifBtns.appendChild(gifCancelBtn);
    gifBtns.appendChild(gifOkBtn);
    gifCard.appendChild(gifTitle);
    gifCard.appendChild(gifPreviewBox);
    gifCard.appendChild(gifHint);
    gifCard.appendChild(gifNameInput);
    gifCard.appendChild(gifBtns);
    gifMask.appendChild(gifCard);
    document.body.appendChild(gifMask);
    gifCancelBtn.addEventListener('click', hideGifRoleModal);
    gifOkBtn.addEventListener('click', confirmGifRole);
    var gifRoleDataUrl = null;
    var gifRoleFileName = '';
    var gifRoleAnimType = 'gif';
    function openGifRoleModal(dataUrl, fileName, animType) {
      gifRoleDataUrl = dataUrl;
      gifRoleAnimType = animType === 'apng' ? 'apng' : 'gif';
      gifRoleFileName = (fileName || '').replace(/.[^.]+$/, '') || '新角色';
      if (gifRoleAnimType === 'apng') {
        gifTitle.textContent = '导入 APNG 动图角色';
        gifHint.textContent = 'APNG 动图不支持裁剪，将按原始尺寸原样导入';
      } else {
        gifTitle.textContent = '导入 GIF 动图角色';
        gifHint.textContent = 'GIF 动图不支持裁剪，将按原始尺寸原样导入';
      }
      gifNameInput.value = '';
      gifPreviewImg.src = dataUrl;
      gifMask.style.display = 'flex';
    }
    function hideGifRoleModal() {
      gifMask.style.display = 'none';
      gifRoleDataUrl = null;
      gifRoleFileName = '';
      gifRoleAnimType = 'gif';
      gifPreviewImg.src = '';
    }
    function confirmGifRole() {
      try {
        var name = (gifNameInput.value || '').trim().slice(0, 16) || '新角色';
        if (!gifRoleDataUrl) {
          hideGifRoleModal();
          return;
        }
        fetch(ROLE_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            name: name,
            image: gifRoleDataUrl,
            format: gifRoleAnimType
          })
        }).then(function (r) {
          return r.json();
        }).then(function (d) {
          requireSaved(d);
          if (d && d.ok && Array.isArray(d.roles)) {
            roleList = d.roles;
            renderRolePanel();
            var newest = null;
            for (var i = 0; i < roleList.length; i++) {
              if (roleList[i].id !== 'default' && (!newest || roleList[i].createdAt > newest.createdAt)) newest = roleList[i];
            }
            if (newest) applyRole(newest.id, newest.name, roleUrl(newest.id));
            hideGifRoleModal();
          }
        }).catch(assetFailure);
      } catch (err) { assetFailure(err); }
    }
    var confirmMask = document.createElement('div');
    confirmMask.className = 'dshwv-confirmmask';
    confirmMask.style.display = 'none';
    var confirmCard = document.createElement('div');
    confirmCard.className = 'dshwv-confirmwin';
    var confirmText = document.createElement('div');
    confirmText.className = 'dshwv-confirmtext';
    var confirmBtns = document.createElement('div');
    confirmBtns.className = 'dshwv-confirmbtns';
    var confirmNoBtn = document.createElement('button');
    confirmNoBtn.type = 'button';
    confirmNoBtn.className = 'dshwv-cropbtn dshwv-cropbtn-no';
    confirmNoBtn.textContent = '取消';
    var confirmYesBtn = document.createElement('button');
    confirmYesBtn.type = 'button';
    confirmYesBtn.className = 'dshwv-cropbtn dshwv-cropbtn-ok';
    confirmYesBtn.textContent = '删除';
    confirmBtns.appendChild(confirmNoBtn);
    confirmBtns.appendChild(confirmYesBtn);
    confirmCard.appendChild(confirmText);
    confirmCard.appendChild(confirmBtns);
    confirmMask.appendChild(confirmCard);
    document.body.appendChild(confirmMask);
    confirmNoBtn.addEventListener('click', hideConfirm);
    confirmYesBtn.addEventListener('click', function () {
      var cb = confirmCb;
      hideConfirm();
      if (cb) cb();
    });
    var audioEditMask = document.createElement('div');
    audioEditMask.className = 'dshwv-audiomask';
    audioEditMask.style.display = 'none';
    var audioEditCard = document.createElement('div');
    audioEditCard.className = 'dshwv-audiowin';
    var audioEditTitle = document.createElement('div');
    audioEditTitle.className = 'dshwv-audiotitle';
    audioEditTitle.textContent = '音效组';
    var audioEditName = document.createElement('input');
    audioEditName.type = 'text';
    audioEditName.className = 'dshwv-audionameinput';
    audioEditName.maxLength = 20;
    audioEditName.placeholder = '预设名称';
    var audioEditPressRow = document.createElement('div');
    audioEditPressRow.className = 'dshwv-audiorow';
    var audioEditPressLabel = document.createElement('span');
    audioEditPressLabel.className = 'dshwv-audioslotlabel';
    audioEditPressLabel.textContent = '按压';
    var audioEditPressWrap = document.createElement('div');
    audioEditPressWrap.className = 'dshwv-slotwrap';
    var audioEditPressBtn = document.createElement('button');
    audioEditPressBtn.type = 'button';
    audioEditPressBtn.className = 'dshwv-slotbtn';
    audioEditPressBtn.textContent = '小黄鸭·按下';
    var audioEditPressPanel = document.createElement('div');
    audioEditPressPanel.className = 'dshwv-slotlist';
    audioEditPressWrap.appendChild(audioEditPressBtn);
    audioEditPressWrap.appendChild(audioEditPressPanel);
    var audioEditPressImport = document.createElement('button');
    audioEditPressImport.type = 'button';
    audioEditPressImport.className = 'dshwv-audiosmallimport';
    audioEditPressImport.textContent = '导入';
    audioEditPressImport.title = '导入并裁剪按压音';
    audioEditPressRow.appendChild(audioEditPressLabel);
    audioEditPressRow.appendChild(audioEditPressWrap);
    audioEditPressRow.appendChild(audioEditPressImport);
    var audioEditReleaseRow = document.createElement('div');
    audioEditReleaseRow.className = 'dshwv-audiorow';
    var audioEditReleaseLabel = document.createElement('span');
    audioEditReleaseLabel.className = 'dshwv-audioslotlabel';
    audioEditReleaseLabel.textContent = '松开';
    var audioEditReleaseWrap = document.createElement('div');
    audioEditReleaseWrap.className = 'dshwv-slotwrap';
    var audioEditReleaseBtn = document.createElement('button');
    audioEditReleaseBtn.type = 'button';
    audioEditReleaseBtn.className = 'dshwv-slotbtn';
    audioEditReleaseBtn.textContent = '小黄鸭·松开';
    var audioEditReleasePanel = document.createElement('div');
    audioEditReleasePanel.className = 'dshwv-slotlist';
    audioEditReleaseWrap.appendChild(audioEditReleaseBtn);
    audioEditReleaseWrap.appendChild(audioEditReleasePanel);
    var audioEditReleaseImport = document.createElement('button');
    audioEditReleaseImport.type = 'button';
    audioEditReleaseImport.className = 'dshwv-audiosmallimport';
    audioEditReleaseImport.textContent = '导入';
    audioEditReleaseImport.title = '导入并裁剪松开音';
    audioEditReleaseRow.appendChild(audioEditReleaseLabel);
    audioEditReleaseRow.appendChild(audioEditReleaseWrap);
    audioEditReleaseRow.appendChild(audioEditReleaseImport);
    var audioEditBtns = document.createElement('div');
    audioEditBtns.className = 'dshwv-cropbtns';
    var audioEditCancel = document.createElement('button');
    audioEditCancel.type = 'button';
    audioEditCancel.className = 'dshwv-cropbtn dshwv-cropbtn-no';
    audioEditCancel.textContent = '取消';
    var audioEditPlay = document.createElement('button');
    audioEditPlay.type = 'button';
    audioEditPlay.className = 'dshwv-cropbtn dshwv-cropbtn-no';
    audioEditPlay.textContent = '试听';
    audioEditPlay.title = '按住播放按压音，松开播放松开音（模拟点击挂件）';
    var audioEditSave = document.createElement('button');
    audioEditSave.type = 'button';
    audioEditSave.className = 'dshwv-cropbtn dshwv-cropbtn-ok';
    audioEditSave.textContent = '保存';
    audioEditBtns.appendChild(audioEditCancel);
    audioEditBtns.appendChild(audioEditPlay);
    audioEditBtns.appendChild(audioEditSave);
    audioEditCard.appendChild(audioEditTitle);
    audioEditCard.appendChild(audioEditName);
    audioEditCard.appendChild(audioEditPressRow);
    audioEditCard.appendChild(audioEditReleaseRow);
    audioEditCard.appendChild(audioEditBtns);
    audioEditMask.appendChild(audioEditCard);
    document.body.appendChild(audioEditMask);
    audioEditCancel.addEventListener('click', hideAudioEditor);
    audioEditPlay.addEventListener('pointerdown', function (e) {
      e.stopPropagation();
      audioEditPreviewDown();
    });
    audioEditPlay.addEventListener('pointerup', function (e) {
      e.stopPropagation();
      audioEditPreviewUp();
    });
    audioEditPlay.addEventListener('pointercancel', audioEditPreviewUp);
    audioEditPlay.addEventListener('pointerleave', audioEditPreviewUp);
    audioEditSave.addEventListener('click', saveAudioGroup);
    audioEditMask.addEventListener('click', function (e) {
      if (e.target === audioEditMask || e.target === audioEditCard) closeAudioSlotPanels();
    });
    var audioCropMask = document.createElement('div');
    audioCropMask.className = 'dshwv-audiomask';
    audioCropMask.style.display = 'none';
    var audioCropCard = document.createElement('div');
    audioCropCard.className = 'dshwv-audiowin';
    var audioCropTitle = document.createElement('div');
    audioCropTitle.className = 'dshwv-audiotitle';
    audioCropTitle.textContent = '裁剪音频';
    var audioCropCanvas = document.createElement('canvas');
    audioCropCanvas.width = 300;
    audioCropCanvas.height = 120;
    audioCropCanvas.className = 'dshwv-audiocropcanvas';
    var audioCropStart = document.createElement('input');
    audioCropStart.type = 'range';
    audioCropStart.min = '0';
    audioCropStart.max = '100';
    audioCropStart.step = '0.001';
    audioCropStart.value = '0';
    audioCropStart.className = 'dshwv-cropzoom';
    var audioCropStartNum = document.createElement('input');
    audioCropStartNum.type = 'number';
    audioCropStartNum.min = '0';
    audioCropStartNum.step = '0.001';
    audioCropStartNum.value = '0';
    audioCropStartNum.className = 'dshwv-cropnum';
    audioCropStartNum.title = '起始时间（秒）';
    var audioCropStartRow = document.createElement('div');
    audioCropStartRow.className = 'dshwv-audiosliderrow';
    audioCropStartRow.appendChild(audioCropStart);
    audioCropStartRow.appendChild(audioCropStartNum);
    var audioCropEnd = document.createElement('input');
    audioCropEnd.type = 'range';
    audioCropEnd.min = '0';
    audioCropEnd.max = '100';
    audioCropEnd.step = '0.001';
    audioCropEnd.value = '100';
    audioCropEnd.className = 'dshwv-cropzoom';
    var audioCropEndNum = document.createElement('input');
    audioCropEndNum.type = 'number';
    audioCropEndNum.min = '0';
    audioCropEndNum.step = '0.001';
    audioCropEndNum.value = '0';
    audioCropEndNum.className = 'dshwv-cropnum';
    audioCropEndNum.title = '结束时间（秒）';
    var audioCropEndRow = document.createElement('div');
    audioCropEndRow.className = 'dshwv-audiosliderrow';
    audioCropEndRow.appendChild(audioCropEnd);
    audioCropEndRow.appendChild(audioCropEndNum);
    audioCropStart.style.display = 'none';
    audioCropEnd.style.display = 'none';
    var audioCropDual = document.createElement('div');
    audioCropDual.className = 'dshwv-dualrange';
    var audioCropDualTrack = document.createElement('div');
    audioCropDualTrack.className = 'dshwv-dualrange-track';
    var audioCropDualFill = document.createElement('div');
    audioCropDualFill.className = 'dshwv-dualrange-fill';
    var audioCropDualStart = document.createElement('div');
    audioCropDualStart.className = 'dshwv-dualrange-thumb';
    var audioCropDualEnd = document.createElement('div');
    audioCropDualEnd.className = 'dshwv-dualrange-thumb';
    audioCropDual.appendChild(audioCropDualTrack);
    audioCropDual.appendChild(audioCropDualFill);
    audioCropDual.appendChild(audioCropDualStart);
    audioCropDual.appendChild(audioCropDualEnd);
    var audioCropDualRow = document.createElement('div');
    audioCropDualRow.className = 'dshwv-audiosliderrow';
    audioCropDualRow.appendChild(audioCropStartNum);
    audioCropDualRow.appendChild(audioCropDual);
    audioCropDualRow.appendChild(audioCropEndNum);
    var audioCropZoomLabel = document.createElement('span');
    audioCropZoomLabel.className = 'dshwv-zoomlabel';
    audioCropZoomLabel.textContent = '缩放倍数';
    var audioCropZoomRange = document.createElement('input');
    audioCropZoomRange.type = 'range';
    audioCropZoomRange.min = '1';
    audioCropZoomRange.max = '50';
    audioCropZoomRange.step = '1';
    audioCropZoomRange.value = '1';
    audioCropZoomRange.className = 'dshwv-cropzoom';
    audioCropZoomRange.title = '波形放大倍数';
    var audioCropZoomNum = document.createElement('input');
    audioCropZoomNum.type = 'number';
    audioCropZoomNum.min = '1';
    audioCropZoomNum.max = '50';
    audioCropZoomNum.step = '1';
    audioCropZoomNum.value = '1';
    audioCropZoomNum.className = 'dshwv-cropnum';
    audioCropZoomNum.title = '放大倍数';
    var audioCropZoomRow = document.createElement('div');
    audioCropZoomRow.className = 'dshwv-audiosliderrow';
    audioCropZoomRow.appendChild(audioCropZoomLabel);
    audioCropZoomRow.appendChild(audioCropZoomRange);
    audioCropZoomRow.appendChild(audioCropZoomNum);
    var audioCropTime = document.createElement('div');
    audioCropTime.className = 'dshwv-audiotime';
    audioCropTime.textContent = '0.0s – 0.0s';
    var audioCropNameRow = document.createElement('div');
    audioCropNameRow.className = 'dshwv-audiosliderrow';
    audioCropNameRow.style.justifyContent = 'center';
    audioCropNameRow.style.margin = '2px 0';
    var audioCropName = document.createElement('input');
    audioCropName.type = 'text';
    audioCropName.maxLength = 30;
    audioCropName.placeholder = '音频片段名称';
    audioCropName.title = '裁剪后片段的名称（可改名，留空用源文件名）';
    audioCropName.className = 'dshwv-audiocropname';
    audioCropNameRow.appendChild(audioCropName);
    audioCropNameRow.style.marginBottom = '12px';
    function updateAudioCropOkState() {
      try {
        audioCropOk.disabled = false;
      } catch (err) {}
    }
    audioCropName.addEventListener('input', updateAudioCropOkState);
    var audioCropBtns = document.createElement('div');
    audioCropBtns.className = 'dshwv-cropbtns';
    var audioCropCancel = document.createElement('button');
    audioCropCancel.type = 'button';
    audioCropCancel.className = 'dshwv-cropbtn dshwv-cropbtn-no';
    audioCropCancel.textContent = '取消';
    var audioCropPlay = document.createElement('button');
    audioCropPlay.type = 'button';
    audioCropPlay.className = 'dshwv-cropbtn dshwv-cropbtn-no';
    audioCropPlay.textContent = '试听';
    audioCropPlay.title = '试听裁剪后的片段';
    var audioCropOk = document.createElement('button');
    audioCropOk.type = 'button';
    audioCropOk.className = 'dshwv-cropbtn dshwv-cropbtn-ok';
    audioCropOk.textContent = '确认';
    audioCropOk.disabled = false;
    audioCropBtns.appendChild(audioCropCancel);
    audioCropBtns.appendChild(audioCropPlay);
    audioCropBtns.appendChild(audioCropOk);
    audioCropCard.appendChild(audioCropTitle);
    audioCropCard.appendChild(audioCropCanvas);
    audioCropCard.appendChild(audioCropDualRow);
    audioCropCard.appendChild(audioCropZoomRow);
    audioCropCard.appendChild(audioCropTime);
    audioCropCard.appendChild(audioCropNameRow);
    audioCropCard.appendChild(audioCropBtns);
    audioCropMask.appendChild(audioCropCard);
    document.body.appendChild(audioCropMask);
    audioCropCancel.addEventListener('click', hideAudioCrop);
    audioCropOk.addEventListener('click', confirmAudioCrop);
    audioCropPlay.addEventListener('click', previewAudioCrop);
    audioCropStart.addEventListener('input', onAudioCropStartInput);
    audioCropEnd.addEventListener('input', onAudioCropEndInput);
    audioCropStartNum.addEventListener('input', onAudioCropStartNumInput);
    audioCropStartNum.addEventListener('change', onAudioCropStartNumChange);
    audioCropEndNum.addEventListener('input', onAudioCropEndNumInput);
    audioCropEndNum.addEventListener('change', onAudioCropEndNumChange);
    audioCropZoomRange.addEventListener('input', onAudioCropZoomInput);
    audioCropZoomNum.addEventListener('input', onAudioCropZoomNumInput);
    audioCropZoomNum.addEventListener('change', onAudioCropZoomNumChange);
    audioCropCanvas.addEventListener('wheel', onAudioCropWheel, {
      passive: false
    });
    audioCropCanvas.addEventListener('pointerdown', onAudioCropSelDown);
    audioCropCanvas.addEventListener('pointermove', onAudioCropSelMove);
    audioCropCanvas.addEventListener('pointerup', onAudioCropSelUp);
    audioCropCanvas.addEventListener('pointercancel', onAudioCropSelUp);
    audioCropDual.addEventListener('pointerdown', onAudioCropDualDown);
    audioCropDual.addEventListener('pointermove', onAudioCropDualMove);
    audioCropDual.addEventListener('pointerup', onAudioCropDualUp);
    audioCropDual.addEventListener('pointercancel', onAudioCropDualUp);
    var textBox = document.createElement('div');
    textBox.className = 'dshwv-text';
    var bubbleFrames = new WhaleRendering.BubbleRenderer(textBox);
    var bubbleTarget, labelEl, amountEl, hintEl;
    var bubbleBuilding = false, bubbleSceneEpoch = 0;
    function bindBubbleParts(parts) {
      bubbleTarget = parts.root; labelEl = parts.label; amountEl = parts.amount;
      hintEl = parts.hint;
    }
    bindBubbleParts(bubbleFrames.front);
    var bubbleBox = document.createElement('div');
    bubbleBox.className = 'dshwv-pop';
    // The thought bubble's fill, outline and shadow come from the theme (pet.css).
    bubbleBox.innerHTML = '<svg viewBox="0 0 1026 700" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">' + '<path class="dshwv-bshape" stroke-linejoin="round" stroke-linecap="round" d="M 827 248 A 373 232 0 1 0 81 246 A 373 232 0 0 0 301 465 A 57 32 10 0 0 413 484 A 373 232 0 0 0 827 248 Z"/>' + '<ellipse class="dshwv-b1" cx="352" cy="561" rx="37.5" ry="26"/>' + '<ellipse class="dshwv-b2" cx="442" cy="646" rx="24.5" ry="18"/>' + '</svg>';
    bubbleBox.appendChild(textBox);
    bubbleBox.addEventListener('click', function (e) {
      e.stopPropagation();
      bubbleNext();
    });
    var body = document.createElement('div');
    body.className = 'dshwv-body';
    body.appendChild(img);
    body.appendChild(bubbleBox);
    // The quota view under the pet places itself on each layout change.
    function petLayout() { window.dispatchEvent(new Event('whale-pet-layout')); }
    img.addEventListener('load', function () {
      WhaleRendering.hitCache.prepare(img.currentSrc || img.src).then(function () {
        petLayout();
        WhaleRendering.presentFor(120);
      });
    });
    root.appendChild(body);
    root.appendChild(menuBtn);
    document.body.appendChild(positioner);
    document.body.appendChild(menuBox);
    var dshwCenterX = 44.25;
    var dshwCenterY = 36;
    function measureBubbleCenter() {
      try {
        var svg = bubbleBox && bubbleBox.querySelector('svg');
        var shape = svg && svg.querySelector('.dshwv-bshape');
        if (!shape || typeof shape.getBBox !== 'function') return;
        var bb = shape.getBBox();
        if (!bb || !isFinite(bb.x + bb.y + bb.width + bb.height) || bb.width <= 0 || bb.height <= 0) return;
        var cx = (bb.x + bb.width / 2) / 1026 * 100;
        var cy = (bb.y + bb.height / 2) / 700 * 100;
        if (!isFinite(cx) || !isFinite(cy)) return;
        dshwCenterX = cx;
        dshwCenterY = cy;
        try {
          var s = document.documentElement.style;
          s.setProperty('--dshw-vx', cx + '%');
          s.setProperty('--dshw-vy', cy + '%');
        } catch (err) {}
      } catch (err) {}
    }
    measureBubbleCenter();
    try {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(measureBubbleCenter);
    } catch (err) {}
    setTimeout(measureBubbleCenter, 120);
    try {
      window.addEventListener('load', function () {
        measureBubbleCenter();
      });
    } catch (err) {}
    var state = {
      scale: 1.5,
      h: 'right',
      hOff: 0,
      v: 'bottom',
      vOff: 0,
      left: 0,
      top: 0,
      balance: null,
      balanceText: '',
      currency: null,
      todayUsage: null,
      todayUsageSource: 'ledger',
      subscription: null,
      status: 'loading',
      message: '',
      flip: false
    };
    var SNAP_KEY = 'dshw-snap';
    var SNAP_VER = 3;
    var SNAP_DEFAULTS = {
      mode: 'ratio',
      ratio: {
        L: 10,
        T: 0,
        R: 10,
        B: 15,
        F: 50
      },
      px: {
        L: 80,
        T: 0,
        R: 80,
        B: 80,
        F: -1
      }
    };
    var snapConfig = null;
    function cloneSnap(c) {
      return {
        mode: c.mode,
        ratio: {
          L: c.ratio.L,
          T: c.ratio.T,
          R: c.ratio.R,
          B: c.ratio.B,
          F: c.ratio.F
        },
        px: {
          L: c.px.L,
          T: c.px.T,
          R: c.px.R,
          B: c.px.B,
          F: c.px.F
        }
      };
    }
    function clampSnapKey(mode, key, val, vp) {
      try {
        if (mode === 'px') {
          var w = Math.max(1, vp.w), h = Math.max(1, vp.h);
          var p = snapEdit ? snapEdit.px : snapConfig.px;
          if (key === 'L') return Math.max(0, Math.min(val, p.F >= 0 ? p.F : w / 2));
          if (key === 'R') return Math.max(0, Math.min(val, Math.max(0, w - (p.F >= 0 ? p.F : w / 2))));
          if (key === 'T') return Math.max(0, Math.min(val, Math.max(0, h - p.B)));
          if (key === 'B') return Math.max(0, Math.min(val, Math.max(0, h - p.T)));
          if (key === 'F') return Math.max(p.L, Math.min(val, Math.max(p.L, w - p.R)));
        } else {
          var r = snapEdit ? snapEdit.ratio : snapConfig.ratio;
          if (key === 'L') return Math.max(0, Math.min(val, r.F));
          if (key === 'R') return Math.max(0, Math.min(val, 100 - r.F));
          if (key === 'T') return Math.max(0, Math.min(val, 100 - r.B));
          if (key === 'B') return Math.max(0, Math.min(val, 100 - r.T));
          if (key === 'F') return Math.max(r.L, Math.min(val, 100 - r.R));
        }
      } catch (err) {}
      return val;
    }
    function fixSnapConfig(cfg, mode) {
      try {
        var m = mode || cfg.mode;
        if (m === 'off') return;
        var vp = viewport();
        if (m === 'px') {
          var w = Math.max(1, vp.w), h = Math.max(1, vp.h);
          if (!(cfg.px.F >= 0)) {
            cfg.px.F = Math.round(w / 2);
            if (!(cfg.px.L > 0)) cfg.px.L = 80;
            if (!(cfg.px.R > 0)) cfg.px.R = 80;
            cfg.px.B = Math.max(0, cfg.px.B > 0 ? cfg.px.B : 80);
            cfg.px.T = Math.max(0, Math.min(cfg.px.T, Math.max(0, h - cfg.px.B)));
          }
          cfg.px.L = Math.max(0, Math.min(cfg.px.L, cfg.px.F));
          cfg.px.R = Math.max(0, Math.min(cfg.px.R, Math.max(0, w - cfg.px.F)));
          cfg.px.F = Math.max(cfg.px.L, Math.min(cfg.px.F, Math.max(cfg.px.L, w - cfg.px.R)));
          cfg.px.L = Math.max(0, Math.min(cfg.px.L, cfg.px.F));
          cfg.px.R = Math.max(0, Math.min(cfg.px.R, Math.max(0, w - cfg.px.F)));
          cfg.px.T = Math.max(0, Math.min(cfg.px.T, Math.max(0, h - cfg.px.B)));
          cfg.px.B = Math.max(0, Math.min(cfg.px.B, Math.max(0, h - cfg.px.T)));
          cfg.px.T = Math.max(0, Math.min(cfg.px.T, Math.max(0, h - cfg.px.B)));
        } else {
          cfg.ratio.L = Math.max(0, Math.min(cfg.ratio.L, cfg.ratio.F));
          cfg.ratio.R = Math.max(0, Math.min(cfg.ratio.R, 100 - cfg.ratio.F));
          cfg.ratio.F = Math.max(cfg.ratio.L, Math.min(cfg.ratio.F, 100 - cfg.ratio.R));
          cfg.ratio.L = Math.max(0, Math.min(cfg.ratio.L, cfg.ratio.F));
          cfg.ratio.R = Math.max(0, Math.min(cfg.ratio.R, 100 - cfg.ratio.F));
          cfg.ratio.T = Math.max(0, Math.min(cfg.ratio.T, 100 - cfg.ratio.B));
          cfg.ratio.B = Math.max(0, Math.min(cfg.ratio.B, 100 - cfg.ratio.T));
          cfg.ratio.T = Math.max(0, Math.min(cfg.ratio.T, 100 - cfg.ratio.B));
        }
      } catch (err) {}
    }
    function loadSnapConfig() {
      snapConfig = cloneSnap(SNAP_DEFAULTS);
      try {
        var raw = localStorage.getItem(SNAP_KEY);
        if (raw) {
          var d = JSON.parse(raw);
          if (d && d.v === SNAP_VER) {
            if (d.mode === 'ratio' || d.mode === 'px' || d.mode === 'off') snapConfig.mode = d.mode;
            var keys = ['L', 'T', 'R', 'B', 'F'];
            var i, k;
            if (d.ratio) for (i = 0; i < keys.length; i++) {
              k = keys[i];
              if (typeof d.ratio[k] === 'number' && isFinite(d.ratio[k])) snapConfig.ratio[k] = d.ratio[k];
            }
            if (d.px) for (i = 0; i < keys.length; i++) {
              k = keys[i];
              if (typeof d.px[k] === 'number' && isFinite(d.px[k])) snapConfig.px[k] = d.px[k];
            }
          }
        }
      } catch (err) {}
      fixSnapConfig(snapConfig, 'ratio');
      fixSnapConfig(snapConfig, 'px');
    }
    function saveSnapConfig() {
      try {
        var out = cloneSnap(snapConfig);
        out.v = SNAP_VER;
        localStorage.setItem(SNAP_KEY, JSON.stringify(out));
      } catch (err) {}
    }
    loadSnapConfig();
    var busy = false;


    var drag = null;


    var bubbleShown = false;
    var bubbleTtlTimer = null;
    var bubbleScene = null;
    function bubbleClearAll() {
      ++bubbleSceneEpoch;
      bubbleFrames.cancel();
      if (bubbleTtlTimer) clearTimeout(bubbleTtlTimer);
      bubbleTtlTimer = null;
    }
    function bubbleCloseVisual() {
      bubbleFrames.close();
      bubbleBox.classList.remove('dshwv-pop-open');
    }
    function sceneOpen(kind, renderFn, ttlMs) {
      var wasOpen = bubbleShown;
      var previousScene = bubbleScene;
      bubbleClearAll();
      var entry = bubbleSceneEpoch;
      bubbleScene = { kind: kind, ttlMs: ttlMs || 0 };
      bubbleShown = true;
      // Build once at entry. Data callbacks cannot repaint either live buffer.
      // Resolves whether this scene is on screen.
      return bubbleFrames.open(function (parts) {
        bubbleBuilding = true;
        bindBubbleParts(parts);
        try {
          WhaleMoney.applyLatestQuote({ refreshBindings: false });
          renderFn();
        }
        finally { bubbleBuilding = false; bindBubbleParts(bubbleFrames.front); }
      }, function () {
        bubbleBox.classList.add('dshwv-pop-open');
        WhaleRendering.presentFor(650);
      }).then(function (committed) {
        if (entry !== bubbleSceneEpoch) return false;
        bindBubbleParts(bubbleFrames.front);
        if (!committed) {
          bubbleScene = previousScene;
          bubbleShown = wasOpen;
          if (!wasOpen) bubbleCloseVisual();
          return false;
        }
        WhaleMoney.refreshBindings(menuBox);
        if (ttlMs > 0) bubbleTtlTimer = setTimeout(bubbleAutoClose, ttlMs);
        return true;
      });
    }
    // System bubbles open without a time here; bubbleQueue closes them.
    function bubbleAutoClose() {
      bubbleTtlTimer = null;
      hideBubble();
    }
    function bubbleResetTtl() {
      try {
        if (bubbleTtlTimer) {
          clearTimeout(bubbleTtlTimer);
          bubbleTtlTimer = null;
        }
      } catch (err) {}
      if (bubbleScene && bubbleScene.ttlMs > 0) bubbleTtlTimer = setTimeout(bubbleAutoClose, bubbleScene.ttlMs);
    }
    function bubbleText(tag, className, text) {
      var el = document.createElement(tag);
      el.className = className;
      el.textContent = text;
      return el;
    }
    // The bubble only says how much quota is left. A subscription shows its
    // windows side by side under the account's name, or what just happened.
    function bubbleRenderQuota() {
      if (hasSubscriptionQuota()) bubbleRenderSubscription(state.subscription, bubbleLabelText());
      else bubbleRenderBalance();
    }
    // An API account: what is left, and today's spend or why nothing shows yet.
    function bubbleRenderBalance() {
      labelEl.textContent = bubbleLabelText();
      render();
    }
    function bubbleRenderSubscription(snapshot, heading) {
      labelEl.style.display = 'none';
      amountEl.style.display = 'none';
      hintEl.style.display = 'none';
      var box = bubbleText('div', 'dshwv-quota', '');
      if (heading) box.appendChild(bubbleText('div', 'dshwv-quota-head', heading));
      var stats = bubbleText('div', 'dshwv-quota-stats', '');
      WhaleUsagePresentation.quotaStats(snapshot).forEach(function (stat, index) {
        if (index) stats.appendChild(bubbleText('span', 'dshwv-quota-sep', ''));
        var cell = bubbleText('div', 'dshwv-quota-stat dshwv-quota-' + stat.level, '');
        cell.appendChild(bubbleText('span', 'dshwv-quota-name', stat.name));
        cell.appendChild(bubbleText('span', 'dshwv-quota-value' + (/%$/.test(stat.value) ? '' : ' dshwv-quota-word'), stat.value));
        stats.appendChild(cell);
      });
      box.appendChild(stats);
      WhaleUsagePresentation.quotaResets(snapshot).forEach(function (text) {
        box.appendChild(bubbleText('div', 'dshwv-quota-hint', text));
      });
      bubbleTarget.appendChild(box);
    }
    function bubbleRenderCost(amount, notice) {
      notice = notice || WhaleTurnNotice.snapshot({ amount: amount }, state.currency);
      if (notice.provider === 'Claude') {
        if (WhaleUsagePresentation.hasSubscription(notice.subscription)) bubbleRenderSubscription(notice.subscription, 'Claude 回复完成');
        else bubbleRenderText([{ text: 'Claude 回复完成', size: 7, bold: true }, { text: '额度等待更新', size: 4 }]);
        return;
      }
      var view = WhaleUsagePresentation.taskBubble(notice, fmt);
      if (view.kind === 'subscription') {
        bubbleRenderSubscription(notice.subscriptionRateLimits, view.heading);
        return;
      }
      labelEl.className = 'dshwv-label dshwv-cost-label';
      labelEl.textContent = view.label;
      amountEl.className = 'dshwv-amount dshwv-cost';
      if (notice.amount === null) amountEl.textContent = view.amount;
      else {
        WhaleMoney.bind(amountEl, function () { return WhaleUsagePresentation.taskBubble(notice, fmt).amount; });
      }
      amountEl.title = view.note;
      hintEl.className = 'dshwv-hint dshwv-cost-hint';
      hintEl.textContent = view.hint;
      hintEl.title = view.note;
    }
    // System bubbles: a title and a line or two, each with its size.
    function bubbleRenderText(rows) {
      if (!bubbleBuilding) return; // Including switching: only the entry builder may write.
      labelEl.style.display = 'none';
      amountEl.style.display = 'none';
      hintEl.style.display = 'none';
      (rows || []).forEach(function (row) {
        if (!row || !row.text) return;
        var line = bubbleText('div', 'dshwv-trow' + (row.bold ? ' dshwv-trow-strong' : ''), String(row.text));
        line.style.fontSize = 'calc(var(--dshw-u) * ' + bubbleModuleFontU(row.size) + ')';
        bubbleTarget.appendChild(line);
      });
    }
    function bubbleModuleFontU(level) {
      var n = Number(level) || 6;
      n = Math.max(1, Math.min(50, Math.round(n)));
      return Math.round(40 + (n - 1) * 200 / 49);
    }
    function hasSubscriptionQuota(snapshot) {
      return WhaleUsagePresentation.hasSubscription(snapshot || state.subscription);
    }
    function bubbleLabelText() {
      return WhaleQuotaPresentation.label(quotaAccount);
    }
    // A click on the pet shows the quota, or dismisses an approval reminder.
    // Clicking again while it shows keeps it there a while longer.
    function whaleClick() {
      try {
        if (!bubbleOn) return;
        var systemBubble = bubbleQueue.current();
        if (systemBubble) {
          if (systemBubble.kind === 'approval') bubbleQueue.dismiss();
          return;
        }
        if (bubbleShown) {
          bubbleResetTtl();
          return;
        }
        sceneOpen('normal', bubbleRenderQuota, BUBBLE_MS);
      } catch (err) {}
    }
    // A click on the bubble closes it, or shows the next system bubble.
    function bubbleNext() {
      try {
        if (!bubbleShown) return;
        if (bubbleQueue.dismiss()) return;
        hideBubble();
      } catch (err) {}
    }
    function hideBubble() {
      bubbleQueue.clear();
      closeBubbleScene();
    }
    function closeBubbleScene() {
      bubbleClearAll();
      bubbleScene = null;
      bubbleShown = false;
      bubbleCloseVisual();
    }
    function showCostBubble(amount, notice) {
      notice = notice || WhaleTurnNotice.snapshot({ amount: amount }, state.currency);
      if (!bubbleOn || !WhaleTurnNotice.enabled(notice, {
        failed: failedNoticeToggle.checked, cancelled: cancelledNoticeToggle.checked
      }, turnCostOn)) return;
      pushSystemBubble({
        kind: 'cost',
        amount: amount,
        notice: notice,
        rank: 3
      });
    }
    function showClaudeTurnBubble(subscription) {
      if (!bubbleOn) return;
      pushSystemBubble({ kind: 'cost', amount: null,
        notice: { provider: 'Claude', completionKind: 'success', subscription: subscription }, rank: 3 });
    }
    function playApprovalSound() {
      if (!soundOn || usageSet && usageSet.approvalSound && !usageSet.approvalSound.on) return;
      try {
        playSelectedSound(approvalSoundSel.value || 'preset:fx1:release');
      } catch (err) {}
    }
    function playPomodoroSound() {
      if (!soundOn || usageSet && usageSet.pomodoroSound && !usageSet.pomodoroSound.on) return;
      try {
        playSelectedSound(pomodoroSoundSel.value || 'preset:fx1:release');
      } catch (err) {}
    }
    function showApprovalReminder() {
      playApprovalSound();
      if (!bubbleOn) return;
      var item = {
        kind: 'approval',
        rows: [
          { text: '需要批准', size: 9, bold: true },
          { text: '请到原会话批准', size: 5 }
        ],
        ttlMs: 0
      };
      bubbleQueue.approval(item);
    }
    var USAGE_ALERT_TTL = 6500;
    // Queues a completion or usage alert; false when bubbles are off, so an
    // alert can use its popup card instead.
    function pushSystemBubble(item) {
      if (!bubbleOn || !item || !item.kind) return false;
      var ttlMs = item.kind === 'cost' ? turnCostCloseMs > 0 ? turnCostCloseMs : 0 : item.ttlMs != null ? item.ttlMs : USAGE_ALERT_TTL;
      bubbleQueue.push(Object.assign({}, item, { ttlMs: ttlMs }));
      return true;
    }
    function clamp(v, lo, hi) {
      return v < lo ? lo : v > hi ? hi : v;
    }
    function viewport() {
      return {
        w: window.innerWidth || document.documentElement.clientWidth || 1280,
        h: window.innerHeight || document.documentElement.clientHeight || 800
      };
    }
    function rightGap() {
      if (!scrollGapOn) return 0;
      return scrollGapPx > 0 ? scrollGapPx : 0;
    }
    function fmt(balance, currency) {
      return WhaleMoney.formatMoney(balance, currency || state && state.currency || 'USD', true);
    }
    function hasBalanceDisplay(values) {
      return WhaleUsagePresentation.hasBalance(values);
    }
    
    // Only the scene's entry builder writes; refresh() never repaints a bubble.
    function render() {
      if (!bubbleBuilding) return;
      var captured = { balance: state.balance, balanceText: state.balanceText, todayUsage: state.todayUsage, currency: state.currency || 'USD', status: state.status, message: state.message };
      var options = { formatMoney: fmt };
      WhaleMoney.bind(amountEl, function () { return WhaleUsagePresentation.balanceBubble(captured, options).amount; });
      WhaleMoney.bind(hintEl, function () { return WhaleUsagePresentation.balanceBubble(captured, options).hint; });
    }
    function refreshOpenNormalBubble() {
      if (!bubbleShown || !bubbleScene || bubbleScene.kind !== 'normal') return;
      sceneOpen('normal', bubbleRenderQuota, bubbleScene.ttlMs || BUBBLE_MS);
    }
    var quotaSnapshot = null, quotaAccount = null, quotaKey = '';
    var quotaAlertSeq = Number(localStorage.getItem('dshw-quota-alert-seq') || 0), quotaAlertsAligned = false, quotaStartedAt = Date.now();
    // A quota running low or a day's budget passed, as the quota book raised
    // it: each shows once, as a system bubble. Ones raised before this page
    // started are not shown again.
    function showQuotaAlerts(alerts) {
      (alerts || []).forEach(function (alert) {
        if (!(alert.seq > quotaAlertSeq)) return;
        quotaAlertSeq = alert.seq;
        if (quotaAlertsAligned || alert.at >= quotaStartedAt) {
          pushSystemBubble({ kind: 'alert', rank: 2, rows: [{ text: alert.title, size: 6, bold: true }, { text: alert.text, size: 5 }] });
        }
      });
      quotaAlertsAligned = true;
      try { localStorage.setItem('dshw-quota-alert-seq', String(quotaAlertSeq)); } catch (err) {}
    }
    // Shows the quota book's current account: the state the bubbles read, the
    // title, and the snapshot for the view under the pet.
    function applyQuotas(snapshot) {
      quotaSnapshot = snapshot;
      showQuotaAlerts(snapshot.alerts);
      var account = WhaleQuotaPresentation.current(snapshot);
      quotaAccount = account;
      window.dispatchEvent(new CustomEvent('whale-quotas', { detail: snapshot }));
      var key = JSON.stringify(account);
      if (key === quotaKey) return;
      quotaKey = key;
      Object.assign(state, WhaleQuotaPresentation.bubbleState(account));
      var note = account ? WhaleQuotaPresentation.status(account) : '';
      root.title = account ? WhaleQuotaPresentation.title(account) + (note ? ' · ' + note : '') : '额度';
      img.alt = WhaleQuotaPresentation.label(account);
      refreshOpenNormalBubble();
    }
    function express() {
      positioner.style.transform = 'translate3d(' + state.left + 'px,' + state.top + 'px,0)';
      root.classList.toggle('dshwv-left', !!state.flip);
      // Without room above the pet for its bubble, the bubble sits beside its head.
      root.classList.toggle('dshwv-beside', state.top < 0);
      petLayout();
      WhaleRendering.presentFor(drag && drag.active ? 0 : 200);
    }
    function settle() {
      var vp = viewport();
      var w = root.offsetWidth || root.getBoundingClientRect().width || 0;
      var h = root.offsetHeight || root.getBoundingClientRect().height || 0;
      if (drag && drag.active) {
        state.left = clamp(state.left, 0, Math.max(0, vp.w - w - rightGap()));
        state.top = clamp(state.top, topMin(h), Math.max(0, vp.h - h));
        express();
        return;
      }
      if (state.h === 'right') {
        state.left = Math.max(0, vp.w - w - state.hOff - rightGap());
      } else if (state.h === 'left') {
        state.left = clamp(state.hOff, 0, Math.max(0, vp.w - w - rightGap()));
      } else {
        state.left = clamp(state.left, 0, Math.max(0, vp.w - w - rightGap()));
      }
      if (state.v === 'bottom') {
        state.top = Math.max(topMin(h), vp.h - h - state.vOff);
      } else if (state.v === 'top') {
        state.top = clamp(state.vOff, topMin(h), Math.max(0, vp.h - h));
      } else {
        state.top = clamp(state.top, topMin(h), Math.max(0, vp.h - h));
      }
      refreshFlip();
    }
    function snapBounds(vp) {
      var b = {
        L: 0,
        T: 0,
        R: vp.w,
        B: vp.h,
        F: vp.w / 2
      };
      try {
        var cfg = snapConfig;
        if (!cfg || cfg.mode === 'off') return b;
        if (cfg.mode === 'px') {
          b.L = cfg.px.L;
          b.T = cfg.px.T;
          b.R = vp.w - cfg.px.R;
          b.B = vp.h - cfg.px.B;
          b.F = cfg.px.F;
        } else {
          b.L = vp.w * cfg.ratio.L / 100;
          b.T = vp.h * cfg.ratio.T / 100;
          b.R = vp.w * (100 - cfg.ratio.R) / 100;
          b.B = vp.h * (100 - cfg.ratio.B) / 100;
          b.F = vp.w * cfg.ratio.F / 100;
        }
      } catch (err) {}
      return b;
    }
    function snapZones(cx, cyBox, cyImg, vp) {
      var out = {
        zH: null,
        zV: null,
        flip: false
      };
      try {
        var cfg = snapConfig;
        if (!cfg || cfg.mode === 'off') return out;
        var b = snapBounds(vp);
        out.flip = cx < b.F;
        if (cx < b.L) out.zH = 'left'; else if (cx > b.R) out.zH = 'right';
        if (cyBox < b.T) out.zV = 'top'; else if (cyImg > b.B) out.zV = 'bottom';
      } catch (err) {}
      return out;
    }
    function refreshFlip() {
      try {
        if (state.h === 'left') {
          state.flip = true;
        } else if (state.h === 'right') {
          state.flip = false;
        } else {
          var w = root.offsetWidth || root.getBoundingClientRect().width || 0;
          var h = root.offsetHeight || root.getBoundingClientRect().height || 0;
          var ac = artCenterAt(state.left, state.top, w, h, !!state.flip);
          var vp = viewport();
          state.flip = ac.cx < snapBounds(vp).F;
        }
        express();
      } catch (err) {}
    }
    // The pet goes up until its picture meets the top of the screen; the
    // bubble space above it may then leave the screen (see express).
    function topMin(h) {
      return -h * (1 - 0.5945);
    }
    function artCenterAt(left, top, w, h, flipped) {
      var iw = Math.max(1, w * 0.5945);
      var cx = flipped ? left + iw / 2 : left + w - iw / 2;
      var cy = top + h - iw / 2;
      return {
        cx: cx,
        cy: cy
      };
    }
    var refreshQueued = false, refreshManual = false;
    // Reads the quota book. A manual refresh has the runtime query every API
    // account first; reads asked for meanwhile run once afterwards.
    function refresh(manual) {
      if (manual) refreshManual = true;
      if (busy) { refreshQueued = true; return; }
      busy = true;
      var forced = refreshManual;
      refreshManual = false;
      usageClient.quotas({ manual: forced }).then(applyQuotas).catch(function () {
        if (!quotaAccount) Object.assign(state, WhaleQuotaPresentation.bubbleState(null), { status: 'error', message: '额度暂时无法读取' });
      }).finally(function () {
        busy = false;
        if (refreshQueued) { refreshQueued = false; refresh(false); }
      });
    }
    var soundOn = true;
    var soundVol = 0.9;
    var soundSet = 'duck';
    var usageMode = 'ledger';
    var bubbleOn = true;
    var turnCostOn = true;
    var turnCostCloseMs = 5000;
    var scrollGapOn = false;
    var scrollGapPx = 17;
    var menuBtnHide = false;
    function saveConfig() {
      try {
        fetch(SIZE_URL, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            scale: state.scale,
            sound: soundOn,
            vol: soundVol,
            soundSet: soundSet,
            usageMode: usageMode,
            bubbleOn: bubbleOn,
            turnCostOn: turnCostOn,
            turnCostCloseMs: turnCostCloseMs,
            scrollGapOn: scrollGapOn,
            scrollGapPx: scrollGapPx,
            menuBtnHide: menuBtnHide
          })
        });
        var vp = viewport();
        var w = root.offsetWidth || root.getBoundingClientRect().width || 0;
        var h = root.offsetHeight || root.getBoundingClientRect().height || 0;
        var leftDist = state.left;
        var rightDist = vp.w - state.left - w;
        var topDist = state.top;
        var bottomDist = vp.h - state.top - h;
        var hAnchor = leftDist <= rightDist ? 'left' : 'right';
        var hDistRaw = Math.round(Math.min(leftDist, rightDist));
        var hDist = hAnchor === 'right' && scrollGapOn ? Math.max(0, hDistRaw - rightGap()) : hDistRaw;
        localStorage.setItem('dshw-pos', JSON.stringify({
          v: 2,
          hAnchor: hAnchor,
          hDist: hDist,
          vAnchor: topDist <= bottomDist ? 'top' : 'bottom',
          vDist: Math.round(Math.min(topDist, bottomDist))
        }));
      } catch (err) {}
    }
    function setUsageMode(v) {
      usageMode = 'ledger';
      saveConfig();
      refresh(false);
    }
    function setBubbleOn(v) {
      bubbleOn = !!v;
      bubbleToggle.checked = bubbleOn;
      saveConfig();
      if (!bubbleOn) hideBubble();
    }
    function setTurnCostOn(v) {
      turnCostOn = !!v;
      turnCostToggle.checked = turnCostOn;
      turnCostCloseInput.disabled = !turnCostOn;
      saveConfig();
      if (!turnCostOn) bubbleQueue.clear('cost');
    }
    function setTurnCostClose(v) {
      if (!turnCostOn) return;
      var n = Math.max(0, Math.round(Number(v) || 0));
      turnCostCloseMs = n * 1000;
      turnCostCloseInput.value = String(n);
      saveConfig();
    }
    function setScrollGapOn(v) {
      scrollGapOn = !!v;
      scrollGapToggle.checked = scrollGapOn;
      scrollGapInput.disabled = !scrollGapOn;
      saveConfig();
      settle();
    }
    function setScrollGapPx(v) {
      if (!scrollGapOn) return;
      var n = Math.max(0, Math.round(Number(v) || 0));
      scrollGapPx = n;
      scrollGapInput.value = String(n);
      saveConfig();
      settle();
    }
    function applyMenuBtnHideUI() {
      try {
        menuBtn.classList.toggle('dshwv-menu-btn-hidden', menuBtnHide);
        if (menuBtnHide) menuBtn.classList.remove('dshwv-menu-btn-visible');
      } catch (err) {}
    }
    function setMenuBtnHide(v) {
      menuBtnHide = !!v;
      if (menuHideToggle) menuHideToggle.checked = menuBtnHide;
      saveConfig();
      applyMenuBtnHideUI();
    }
    function scaleToDisplay(s) {
      return Math.round((s - MIN_SCALE) / ((MAX_SCALE - MIN_SCALE) / 19)) + 1;
    }
    function setScale(v) {
      var next = Math.round(Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(v))) * 10) / 10;
      var prevTrans = positioner.style.transition;
      positioner.style.transition = 'none';
      var rect = whaleLayoutRect();
      var fx = state.flip ? rect.left : rect.right;
      var fy = rect.bottom;
      state.scale = next;
      root.style.setProperty('--dshw-scale', String(next));
      scaleInput.value = String(next);
      paintRange(scaleInput);
      scaleNumber.value = String(scaleToDisplay(next));
      saveConfig();
      var r2 = whaleLayoutRect();
      var vp = viewport();
      if (state.flip) {
        state.left = Math.min(Math.max(fx, 0), Math.max(0, vp.w - r2.width));
      } else {
        state.left = Math.min(Math.max(fx - r2.width, 0), Math.max(0, vp.w - r2.width));
      }
      state.top = Math.min(Math.max(fy - r2.height, topMin(r2.height)), Math.max(0, vp.h - r2.height));
      express();
      requestAnimationFrame(function () {
        positioner.style.transition = prevTrans;
      });
    }
    function setVol(v) {
      var next = Math.round(Math.min(1, Math.max(0, Number(v))) * 100) / 100;
      soundVol = next;
      soundOn = next > 0;
      volInput.value = String(next);
      paintRange(volInput);
      volPct.textContent = Math.round(next * 100) + '%';
      try {
        if (pressAudio) pressAudio.volume = next;
        if (releaseAudio) releaseAudio.volume = next;
      } catch (err) {}
      saveConfig();
    }
    function setSoundSet(v) {
      soundSet = typeof v === 'string' && v ? v : 'duck';
      setAudioBtnText(audioGroupName(soundSet));
      applySoundSet();
      saveConfig();
    }
    var SQUISH = 'scaleY(0.88) scaleX(1.05)';
    var pressAudio = null;
    var releaseAudio = null;
    var pressing = false;
    var pressEnded = false;
    var releasePlayed = false;
    var releaseTimer = null;
    function applySoundSet() {
      try {
        var pEmpty = audioGroupSlotEmpty(soundSet, 'press');
        var rEmpty = audioGroupSlotEmpty(soundSet, 'release');
        if (pEmpty) {
          pressAudio = null;
        } else {
          pressAudio = new Audio('/dsh-whale/sound/press.mp3?set=' + soundSet);
          pressAudio.preload = 'auto';
          pressAudio.volume = soundVol;
        }
        if (rEmpty) {
          releaseAudio = null;
        } else {
          releaseAudio = new Audio('/dsh-whale/sound/release.mp3?set=' + soundSet);
          releaseAudio.preload = 'auto';
          releaseAudio.volume = soundVol;
        }
      } catch (err) {}
    }
    function playPress() {
      if (!soundOn) return;
      if (!pressAudio) {
        pressEnded = true;
        return;
      }
      try {
        if (releaseTimer) {
          clearTimeout(releaseTimer);
          releaseTimer = null;
        }
        if (releaseAudio) {
          releaseAudio.pause();
          releaseAudio.currentTime = 0;
        }
        pressEnded = false;
        releasePlayed = false;
        pressAudio.onended = function () {
          pressEnded = true;
          if (!pressing && !releasePlayed) playRelease();
        };
        pressAudio.currentTime = 0;
        var p = pressAudio.play();
        if (p && typeof p.catch === 'function') p.catch(function () {});
      } catch (err) {}
    }
    function playRelease() {
      if (releasePlayed || !releaseAudio || !soundOn) return;
      releasePlayed = true;
      try {
        releaseAudio.currentTime = 0;
        var p = releaseAudio.play();
        if (p && typeof p.catch === 'function') p.catch(function () {});
      } catch (err) {}
    }
    function pressDown() {
      body.style.transform = SQUISH;
      pressing = true;
      playPress();
    }
    function pressUp() {
      body.style.transform = 'scaleY(1) scaleX(1)';
      pressing = false;
      if (pressEnded) {
        playRelease();
        return;
      }
      var durKnown = false;
      var remainMs = 0;
      try {
        var dur = pressAudio ? pressAudio.duration : 0;
        if (isFinite(dur) && dur > 0) {
          durKnown = true;
          remainMs = (dur - pressAudio.currentTime) * 1000;
        }
      } catch (err) {}
      if (durKnown) {
        releaseTimer = setTimeout(function () {
          releaseTimer = null;
          playRelease();
        }, Math.max(0, remainMs - 100));
      }
    }
    var menuOpen = false;
    var menuPositionFrame = 0;
    new ResizeObserver(function () {
      if (!menuOpen || menuPositionFrame) return;
      // Read/write menu geometry in the next frame, never while the browser is
      // delivering resize observations for that same menu.
      menuPositionFrame = requestAnimationFrame(function () {
        menuPositionFrame = 0;
        if (menuOpen) positionMenu();
      });
    }).observe(menuBox);
    function toggleMenu() {
      menuOpen = !menuOpen;
      if (menuOpen) positionMenu();
      menuBox.classList.toggle('dshwv-menu-open', menuOpen);
      if (menuOpen && !menuBtnHide) menuBtn.classList.add('dshwv-menu-btn-visible');
    }
    function closeMenu() {
      menuOpen = false;
      if (menuPositionFrame) cancelAnimationFrame(menuPositionFrame);
      menuPositionFrame = 0;
      menuBox.classList.remove('dshwv-menu-open');
      closeRolePanel();
      closeAudioGroupPanel();
      closeFxInfo();
      positioner.style.transition = '';
      snapCheck();
    }
    function snapCheck() {
      if (!snapConfig || snapConfig.mode === 'off') return;
      var rect = whaleLayoutRect();
      var vp = viewport();
      var w = rect.width, h = rect.height;
      var left = rect.left, top = rect.top;
      var ac = artCenterAt(left, top, w, h, !!state.flip);
      var z = snapZones(ac.cx, top + h / 2, ac.cy, vp);
      var moved = false;
      if (z.zH === 'left') {
        state.h = 'left';
        state.hOff = 0;
        left = 0;
        moved = true;
      } else if (z.zH === 'right') {
        state.h = 'right';
        state.hOff = 0;
        left = vp.w - w - rightGap();
        moved = true;
      } else {
        state.h = null;
        state.hOff = left;
      }
      if (z.zV === 'top') {
        state.v = 'top';
        top = state.vOff = topMin(h);
        moved = true;
      } else if (z.zV === 'bottom') {
        state.v = 'bottom';
        state.vOff = 0;
        top = Math.max(0, vp.h - h);
        moved = true;
      } else {
        state.v = 'bottom';
        state.vOff = Math.max(0, vp.h - top - h);
      }
      state.flip = z.flip;
      if (moved) {
        state.left = left;
        state.top = top;
        settle();
      } else {
        express();
      }
    }
    function positionMenu() {
      try {
        var r = positioner.getBoundingClientRect();
        var b = menuBtn.getBoundingClientRect();
        var vp = viewport();
        var onLeft = r.left + root.offsetWidth / 2 < vp.w / 2;
        var width = menuBox.offsetWidth, height = menuBox.offsetHeight;
        var assetTop = r.top + root.offsetHeight * (1 - 0.5945);
        menuBox.style.left = clamp(onLeft ? b.left : b.right - width, 8, Math.max(8, vp.w - width - 8)) + 'px';
        menuBox.style.right = 'auto';
        menuBox.style.top = clamp(assetTop - height - 6, 8, Math.max(8, vp.h - height - 8)) + 'px';
        menuBox.style.bottom = 'auto';
        menuBox.style.transformOrigin = onLeft ? 'bottom left' : 'bottom right';
      } catch (err) {}
    }
    var ROLE_URL = '/dsh-whale/roles.json';
    var currentRole = {
      id: 'default',
      name: '小鲸鱼',
      url: IMG_URL
    };
    var roleList = [];
    var badRoleIds = Object.create(null);
    var fallbackInProgress = false;
    function recoverBrokenRole() {
      if (fallbackInProgress || img.complete && img.naturalWidth > 0) return;
      var failedId = currentRole.id;
      try { failedId = localStorage.getItem('dshw-role') || failedId; } catch (err) {}
      if (failedId && failedId !== 'default') badRoleIds[failedId] = true;
      if (new URL(img.currentSrc || img.src, location.href).href === new URL(IMG_URL, location.href).href) {
        assetNotice('内置小鲸鱼图片加载失败，请重启挂件或重新安装');
        return;
      }
      fallbackInProgress = true;
      applyRole('default', '小鲸鱼', IMG_URL, true);
    }
    window.addEventListener('whale-role-fallback', recoverBrokenRole);
    function loadRoles() {
      try {
        fetch(ROLE_URL, {
          cache: 'no-store'
        }).then(function (r) {
          return r.json();
        }).then(function (d) {
          if (!d || !d.ok || !Array.isArray(d.roles)) return;
          roleList = d.roles;
          assetWarning(d);
          renderRolePanel();
          if (fallbackInProgress) return;
          var saved = '';
          try {
            saved = localStorage.getItem('dshw-role') || '';
          } catch (err) {}
          var found = null;
          for (var i = 0; i < roleList.length; i++) {
            if (roleList[i].id === saved) {
              found = roleList[i];
              break;
            }
          }
          if (found && !badRoleIds[found.id]) {
            if (currentRole.id !== found.id) applyRole(found.id, found.name, found.url); else renderRolePanel();
          } else if (saved && saved !== 'default') {
            applyRole('default', '小鲸鱼', IMG_URL);
          }
        }).catch(function () {});
      } catch (err) {}
    }
    function setRoleBtnText(t) {
      try {
        roleBtnLabel.textContent = t;
      } catch (err) {}
    }
    function setAudioBtnText(t) {
      try {
        audioGroupBtnLabel.textContent = t;
      } catch (err) {}
    }
    var MARQ_SPEED = 40;
    function bindNameMarquee(item, nameEl) {
      try {
        if (!item || !nameEl) return;
        var timer = null;
        function stop() {
          try {
            if (timer) {
              clearTimeout(timer);
              timer = null;
            }
            var t = nameEl.querySelector('.dshwv-nameinner');
            if (!t) return;
            t.style.transitionTimingFunction = '';
            t.style.transitionDuration = '';
            t.style.transform = '';
            while (t.children && t.children.length > 1) t.removeChild(t.children[t.children.length - 1]);
          } catch (err) {}
        }
        function distOf() {
          try {
            var t = nameEl.querySelector('.dshwv-nameinner');
            if (!t) return 0;
            return t.scrollWidth / 2;
          } catch (err) {
            return 0;
          }
        }
        function textWOf() {
          try {
            var t = nameEl.querySelector('.dshwv-nameinner');
            if (!t || !t.children || !t.children.length) return 0;
            return t.children[0].offsetWidth || 0;
          } catch (err) {
            return 0;
          }
        }
        function ensureDup() {
          var t = nameEl.querySelector('.dshwv-nameinner');
          if (!t || !t.children || t.children.length >= 2) return t;
          var first = t.children[0];
          var c = document.createElement('span');
          c.className = 'dshwv-namecopy';
          c.textContent = first.textContent;
          t.appendChild(c);
          return t;
        }
        function cycle() {
          var dist = distOf();
          var dur = Math.max(200, dist / MARQ_SPEED * 1000);
          timer = setTimeout(function () {
            try {
              cycle();
            } catch (err) {}
          }, dur + 40);
          var t = nameEl.querySelector('.dshwv-nameinner');
          if (!t) return;
          t.style.transitionTimingFunction = 'linear';
          t.style.transitionDuration = '0ms';
          t.style.transform = 'translateX(0px)';
          void t.offsetWidth;
          t.style.transitionDuration = dur + 'ms';
          t.style.transform = 'translateX(' + -dist + 'px)';
        }
        item.addEventListener('mouseenter', function () {
          try {
            stop();
            if (textWOf() <= nameEl.clientWidth + 1) return;
            ensureDup();
            cycle();
          } catch (err) {}
        });
        item.addEventListener('mouseleave', stop);
      } catch (err) {}
    }
    function makeNameCell(className, text) {
      var outer = document.createElement('span');
      outer.className = className;
      var inner = document.createElement('span');
      inner.className = 'dshwv-nameinner';
      var c = document.createElement('span');
      c.className = 'dshwv-namecopy';
      c.textContent = text;
      inner.appendChild(c);
      outer.appendChild(inner);
      return outer;
    }
    var roleLoadGeneration = 0;
    function applyRole(id, name, url, isFallback) {
      var generation = ++roleLoadGeneration;
      var readyImage = new Image();
      readyImage.src = url;
      return Promise.all([readyImage.decode(), WhaleRendering.hitCache.prepare(url)]).then(function () {
        if (generation !== roleLoadGeneration) return false;
        currentRole = {
        id: id,
        name: name,
        url: url
      };
      img.src = url;
      roleBtnThumb.src = url;
      setRoleBtnText(name);
      try {
        localStorage.setItem('dshw-role', id);
      } catch (err) {}
      setupHitTest(url);
      closeRolePanel();
      renderRolePanel();
        WhaleRendering.presentFor(200);
        delete badRoleIds[id];
        fallbackInProgress = false;
        if (isFallback) assetNotice('原角色图片无法显示，已切回小鲸鱼；可在角色菜单重新选择');
        return true;
      }).catch(function () {
        if (generation !== roleLoadGeneration) return false;
        badRoleIds[id] = true;
        fallbackInProgress = false;
        assetNotice(isFallback ? '内置小鲸鱼图片加载失败，请重启挂件或重新安装' : '角色图片无法读取，已保留原角色');
        if (!isFallback) recoverBrokenRole();
        return false;
      });
    }
    function roleUrl(id) {
      if (id === 'default') return IMG_URL;
      return '/dsh-whale/role-image.png?id=' + encodeURIComponent(id);
    }
    function toggleRolePanel() {
      if (rolePanel.classList.contains('dshwv-rolelist-open')) {
        closeRolePanel();
        return;
      }
      try {
        var b = roleBtn.getBoundingClientRect();
        var vp = viewport();
        var panelW = Math.max(200, Math.round(b.width));
        rolePanel.style.width = panelW + 'px';
        rolePanel.style.left = Math.max(4, Math.min(b.left, vp.w - panelW - 4)) + 'px';
        rolePanel.style.top = b.bottom + 6 + 'px';
        rolePanel.style.display = 'block';
        rolePanel.classList.add('dshwv-rolelist-open');
      } catch (err) {}
    }
    function closeRolePanel() {
      rolePanel.classList.remove('dshwv-rolelist-open');
      rolePanel.style.display = 'none';
    }
    function renderRolePanel() {
      try {
        rolePanel.innerHTML = '';
        roleList.forEach(function (r) {
          var item = document.createElement('div');
          item.className = 'dshwv-roleitem' + (currentRole.id === r.id ? ' dshwv-roleitem-cur' : '');
          var thumb = document.createElement('img');
          thumb.className = 'dshwv-rolethumb';
          thumb.src = r.url;
          thumb.alt = '';
          thumb.draggable = false;
          var name = makeNameCell('dshwv-rolename', r.name);
          var nameWrap = document.createElement('span');
          nameWrap.className = 'dshwv-rolenamewrap';
          if (r.format === 'gif' || r.format === 'apng') {
            var gifTag = document.createElement('span');
            gifTag.className = 'dshwv-roleGifTag';
            gifTag.textContent = r.format === 'apng' ? 'APNG' : 'GIF';
            nameWrap.appendChild(gifTag);
          }
          nameWrap.appendChild(name);
          item.appendChild(thumb);
          item.appendChild(nameWrap);
          var pin = document.createElement('button');
          pin.type = 'button';
          pin.className = 'dshwv-rolepin' + (r.pinned ? ' on' : '');
          pin.textContent = '📌';
          pin.title = r.pinned ? '取消置顶' : '置顶';
          pin.addEventListener('click', function (e) {
            e.stopPropagation();
            togglePin(r.id, !r.pinned);
          });
          item.appendChild(pin);
          if (r.id !== 'default') {
            var del = document.createElement('button');
            del.type = 'button';
            del.className = 'dshwv-roledel';
            del.textContent = '✕';
            del.title = '删除角色';
            del.addEventListener('click', function (e) {
              e.stopPropagation();
              deleteRole(r.id);
            });
            item.appendChild(del);
          }
          item.addEventListener('click', function () {
            applyRole(r.id, r.name, roleUrl(r.id));
          });
          bindNameMarquee(item, name);
          rolePanel.appendChild(item);
        });
      } catch (err) {}
    }
    function togglePin(id, pinned) {
      try {
        fetch('/dsh-whale/role-pin.json', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            id: id,
            pinned: pinned
          })
        }).then(function (r) {
          return r.json();
        }).then(function (d) {
          requireSaved(d);
          if (d && d.ok && Array.isArray(d.roles)) {
            roleList = d.roles;
            renderRolePanel();
          }
        }).catch(assetFailure);
      } catch (err) { assetFailure(err); }
    }
    var confirmCb = null;
    function showConfirm(text, cb, okLabel) {
      confirmCb = cb || null;
      confirmText.textContent = text;
      try {
        if (!okLabel) okLabel = String(text || '').indexOf('删除') !== -1 ? '删除' : '确定';
        confirmYesBtn.textContent = okLabel;
      } catch (err) {}
      confirmMask.style.display = 'flex';
    }
    function hideConfirm() {
      confirmMask.style.display = 'none';
      confirmCb = null;
    }
    function deleteRole(id) {
      var r = null;
      for (var i = 0; i < roleList.length; i++) if (roleList[i].id === id) {
        r = roleList[i];
        break;
      }
      showConfirm('确定删除角色「' + (r ? r.name : id) + '」吗？', function () {
        try {
          fetch('/dsh-whale/role-delete.json', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              id: id
            })
          }).then(function (res) {
            return res.json();
          }).then(function (d) {
          requireSaved(d);
            if (d && d.ok && Array.isArray(d.roles)) {
              roleList = d.roles;
              renderRolePanel();
              if (currentRole.id === id) applyRole('default', '小鲸鱼', IMG_URL);
            }
          }).catch(assetFailure);
        } catch (err) { assetFailure(err); }
      });
    }
    var cropState = null;
    function countGifFrames(bytes) {
      try {
        var head = '';
        for (var i = 0; i < 6; i++) head += String.fromCharCode(bytes[i]);
        if (head !== 'GIF87a' && head !== 'GIF89a') return 1;
        var flags = bytes[10];
        var hasGct = (flags & 0x80) !== 0;
        var gctSize = 3 * (1 << (flags & 0x07) + 1);
        var pos = 13 + (hasGct ? gctSize : 0);
        var frames = 0;
        while (pos + 1 < bytes.length) {
          var b = bytes[pos];
          if (b === 0x3b) break;
          if (b === 0x2c) {
            frames++;
            var lctFlag = bytes[pos + 9] & 0x80;
            var lctSize = lctFlag ? 3 * (1 << (bytes[pos + 9] & 0x07) + 1) : 0;
            pos += 10 + lctSize;
            if (pos >= bytes.length) break;
            pos++;
            while (pos < bytes.length) {
              var sz = bytes[pos];
              pos++;
              if (sz === 0) break;
              pos += sz;
            }
          } else if (b === 0x21) {
            pos += 2;
            while (pos < bytes.length) {
              var sz2 = bytes[pos];
              pos++;
              if (sz2 === 0) break;
              pos += sz2;
            }
          } else {
            break;
          }
        }
        return Math.max(1, frames);
      } catch (err) {
        return 1;
      }
    }
    function isAnimatedPng(bytes) {
      return WhaleMediaGuard.isAnimatedPng(bytes);
    }
    async function onRoleFileChosen(input) {
      try {
        var f = input && input.files && input.files[0];
        input.value = '';
        if (!f) return;
        WhaleMediaGuard.checkFile(f, 'role');
        var bytes = await f.arrayBuffer();
        var media = WhaleMediaGuard.inspectImage(bytes, 'role');
        var dataUrl = await mediaDataUrl(new Blob([bytes], { type: media.mime }));
        if (media.animated && (media.format === 'gif' || media.format === 'apng')) openGifRoleModal(dataUrl, f.name, media.format);
        else if (media.animated) throw new Error('动态角色请选择 GIF 或 APNG，避免导入后丢失动画');
        else openCropModal(dataUrl, f.name);
      } catch (err) { assetNotice(err.message); }
    }
    function openCropModal(dataUrl, fileName) {
      try {
        var imgEl = new Image();
        imgEl.onload = function () {
          cropState = {
            img: imgEl,
            zoom: 1,
            ox: 0,
            oy: 0,
            rotation: 0,
            flipH: false,
            flipV: false,
            baseScale: Math.max(CROP_BOX / imgEl.width, CROP_BOX / imgEl.height)
          };
          cropNameInput.value = '';
          cropZoom.value = '1';
          cropZoomNum.value = '100';
          cropAngle.value = '0';
          cropAngleNum.value = '0';
          positionCrop();
          cropMask.style.display = 'flex';
        };
        imgEl.onerror = function () { assetNotice('图片解码失败，请选择其他图片'); };
        imgEl.src = dataUrl;
      } catch (err) {}
    }
    function clampAngle(v) {
      var n = Number(v);
      if (!isFinite(n)) return 0;
      return Math.min(360, Math.max(-360, Math.round(n)));
    }
    function cropDisplaySize() {
      var s = cropState.baseScale * cropState.zoom;
      var w = cropState.img.width * s;
      var h = cropState.img.height * s;
      var rad = cropState.rotation * Math.PI / 180;
      var c = Math.abs(Math.cos(rad));
      var sn = Math.abs(Math.sin(rad));
      return {
        w: w * c + h * sn,
        h: w * sn + h * c,
        s: s
      };
    }
    function positionCrop() {
      if (!cropState) return;
      var d = cropDisplaySize();
      var maxOx = Math.max(0, (d.w - CROP_BOX) / 2);
      var maxOy = Math.max(0, (d.h - CROP_BOX) / 2);
      cropState.ox = Math.min(maxOx, Math.max(-maxOx, cropState.ox));
      cropState.oy = Math.min(maxOy, Math.max(-maxOy, cropState.oy));
      drawCrop();
    }
    function drawCrop() {
      try {
        if (!cropState) return;
        var ctx = cropCanvas.getContext('2d');
        var s = cropState.baseScale * cropState.zoom;
        var rad = cropState.rotation * Math.PI / 180;
        var w = cropState.img.width * s;
        var h = cropState.img.height * s;
        ctx.clearRect(0, 0, CROP_BOX, CROP_BOX);
        ctx.save();
        ctx.translate(CROP_BOX / 2 + cropState.ox, CROP_BOX / 2 + cropState.oy);
        ctx.rotate(rad);
        ctx.scale(cropState.flipH ? -1 : 1, cropState.flipV ? -1 : 1);
        ctx.drawImage(cropState.img, -w / 2, -h / 2, w, h);
        ctx.restore();
      } catch (err) {}
    }
    var cropDrag = null;
    function onCropDown(e) {
      if (!cropState) return;
      try {
        e.preventDefault();
        e.stopPropagation();
      } catch (err) {}
      cropDrag = {
        x: e.clientX,
        y: e.clientY,
        ox: cropState.ox,
        oy: cropState.oy
      };
    }
    function onCropMove(e) {
      if (!cropDrag || !cropState) return;
      cropState.ox = cropDrag.ox + (e.clientX - cropDrag.x);
      cropState.oy = cropDrag.oy + (e.clientY - cropDrag.y);
      positionCrop();
    }
    function onCropUp() {
      cropDrag = null;
    }
    function onCropWheel(e) {
      if (!cropState) return;
      try {
        e.preventDefault();
        e.stopPropagation();
      } catch (err) {}
      var delta = (e.deltaY > 0 ? -1 : 1) * 0.05;
      cropState.zoom = Math.min(3, Math.max(0.3, cropState.zoom + delta));
      cropZoom.value = String(Math.round(cropState.zoom * 100) / 100);
      cropZoomNum.value = String(Math.round(cropState.zoom * 100));
      positionCrop();
    }
    function resetCrop() {
      if (!cropState) return;
      cropState.zoom = 1;
      cropState.ox = 0;
      cropState.oy = 0;
      cropState.rotation = 0;
      cropState.flipH = false;
      cropState.flipV = false;
      cropZoom.value = '1';
      cropZoomNum.value = '100';
      cropAngle.value = '0';
      cropAngleNum.value = '0';
      cropFlipHBtn.classList.remove('dshwv-cropflip-on');
      cropFlipVBtn.classList.remove('dshwv-cropflip-on');
      positionCrop();
    }
    var cropFlipTimer = null;
    function flipCrop(axis) {
      if (!cropState) return;
      try {
        if (cropFlipTimer) {
          clearTimeout(cropFlipTimer);
          cropFlipTimer = null;
        }
      } catch (err) {}
      var flipTarget = axis === 'H' ? 'scaleX(-1)' : 'scaleY(-1)';
      cropCanvas.style.transition = 'transform .3s ease';
      cropCanvas.style.transform = flipTarget;
      cropFlipTimer = setTimeout(function () {
        cropFlipTimer = null;
        try {
          if (axis === 'H') {
            cropState.flipH = !cropState.flipH;
            cropFlipHBtn.classList.toggle('dshwv-cropflip-on', cropState.flipH);
          } else {
            cropState.flipV = !cropState.flipV;
            cropFlipVBtn.classList.toggle('dshwv-cropflip-on', cropState.flipV);
          }
          positionCrop();
          requestAnimationFrame(function () {
            cropCanvas.style.transition = '';
            cropCanvas.style.transform = '';
          });
        } catch (err) {}
      }, 300);
    }
    function confirmCrop() {
      try {
        if (!cropState) return;
        var name = (cropNameInput.value || '').trim().slice(0, 16) || '新角色';
        var s = cropState.baseScale * cropState.zoom;
        var k = 610 / CROP_BOX;
        var rad = cropState.rotation * Math.PI / 180;
        var w = cropState.img.width * s * k;
        var h = cropState.img.height * s * k;
        var out = document.createElement('canvas');
        out.width = 610;
        out.height = 610;
        var octx = out.getContext('2d');
        octx.translate(305 + cropState.ox * k, 305 + cropState.oy * k);
        octx.rotate(rad);
        octx.scale(cropState.flipH ? -1 : 1, cropState.flipV ? -1 : 1);
        octx.drawImage(cropState.img, -w / 2, -h / 2, w, h);
        var dataUrl = out.toDataURL('image/png');
        fetch(ROLE_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            name: name,
            image: dataUrl
          })
        }).then(function (r) {
          return r.json();
        }).then(function (d) {
          requireSaved(d);
          if (d && d.ok && Array.isArray(d.roles)) {
            roleList = d.roles;
            renderRolePanel();
            var newest = null;
            for (var i = 0; i < roleList.length; i++) {
              if (roleList[i].id !== 'default' && (!newest || roleList[i].createdAt > newest.createdAt)) newest = roleList[i];
            }
            if (newest) applyRole(newest.id, newest.name, roleUrl(newest.id));
            hideCropModal();
          }
        }).catch(assetFailure);
      } catch (err) { assetFailure(err); }
    }
    function hideCropModal() {
      cropMask.style.display = 'none';
      cropState = null;
      cropDrag = null;
    }
    var AUDIO_URL = '/dsh-whale/audio.json';
    var audioGroups = [];
    var audioFragments = [];
    var audioLoaded = false;
    var audioGroupPanelOpen = false;
    function loadAudio() {
      try {
        fetch(AUDIO_URL, {
          cache: 'no-store'
        }).then(function (r) {
          return r.json();
        }).then(function (d) {
          if (!d || !d.ok) return;
          if (Array.isArray(d.groups)) audioGroups = d.groups;
          if (Array.isArray(d.fragments)) audioFragments = d.fragments;
          audioLoaded = true;
          assetWarning(d);
          var exists = false;
          for (var i = 0; i < audioGroups.length; i++) if (audioGroups[i].id === soundSet) {
            exists = true;
            break;
          }
          if (!exists) setSoundSet('duck'); else {
            setAudioBtnText(audioGroupName(soundSet));
            try {
              applySoundSet();
            } catch (err) {}
          }
          renderAudioGroupPanel();
          refreshTaskEndAfterAudio();
        }).catch(function () {});
      } catch (err) {}
    }
    function audioGroupName(id) {
      for (var i = 0; i < audioGroups.length; i++) if (audioGroups[i].id === id) return audioGroups[i].name;
      return id === 'duck' ? '小黄鸭' : id === 'fx1' ? '音效1' : id;
    }
    function audioGroupSlotEmpty(id, slot) {
      try {
        for (var i = 0; i < audioGroups.length; i++) {
          var g = audioGroups[i];
          if (g && g.id === id) return g[slot] === '';
        }
      } catch (err) {}
      return false;
    }
    function toggleAudioGroupPanel() {
      if (audioGroupPanelOpen) {
        closeAudioGroupPanel();
        return;
      }
      try {
        renderAudioGroupPanel();
        var b = audioGroupBtn.getBoundingClientRect();
        var vp = viewport();
        var panelW = Math.max(200, Math.round(b.width));
        audioGroupPanel.style.width = panelW + 'px';
        audioGroupPanel.style.left = Math.max(4, Math.min(b.left, vp.w - panelW - 4)) + 'px';
        audioGroupPanel.style.top = b.bottom + 6 + 'px';
        audioGroupPanel.style.display = 'block';
        audioGroupPanel.classList.add('dshwv-audiolist-open');
        audioGroupPanelOpen = true;
      } catch (err) {}
    }
    function closeAudioGroupPanel() {
      audioGroupPanel.classList.remove('dshwv-audiolist-open');
      audioGroupPanel.style.display = 'none';
      audioGroupPanelOpen = false;
    }
    function renderAudioGroupPanel() {
      try {
        audioGroupPanel.innerHTML = '';
        audioGroups.forEach(function (g) {
          var item = document.createElement('div');
          item.className = 'dshwv-audioitem' + (soundSet === g.id ? ' dshwv-audioitem-cur' : '');
          var thumb = document.createElement('span');
          thumb.className = 'dshwv-audiothumb';
          thumb.textContent = '🎵';
          item.appendChild(thumb);
          var name = makeNameCell('dshwv-audioname', g.name);
          item.appendChild(name);
          if (g.preset) {
            var tag = document.createElement('span');
            tag.className = 'dshwv-audiopreset';
            tag.textContent = '预设';
            item.appendChild(tag);
          } else {
            var pin = document.createElement('button');
            pin.type = 'button';
            pin.className = 'dshwv-audiopin' + (g.pinned ? ' on' : '');
            pin.textContent = '📌';
            pin.title = g.pinned ? '取消置顶' : '置顶';
            pin.addEventListener('click', function (e) {
              e.stopPropagation();
              audioPinGroup(g.id, !g.pinned);
            });
            item.appendChild(pin);
            var del = document.createElement('button');
            del.type = 'button';
            del.className = 'dshwv-audiodel';
            del.textContent = '✕';
            del.title = '删除音效组';
            del.addEventListener('click', function (e) {
              e.stopPropagation();
              audioDeleteGroup(g.id);
            });
            item.appendChild(del);
          }
          item.addEventListener('click', function () {
            setSoundSet(g.id);
            closeAudioGroupPanel();
          });
          bindNameMarquee(item, name);
          audioGroupPanel.appendChild(item);
        });
      } catch (err) {}
    }
    function audioPinGroup(id, pinned) {
      try {
        fetch(AUDIO_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            action: 'pin-group',
            id: id,
            pinned: pinned
          })
        }).then(function (r) {
          return r.json();
        }).then(function (d) {
          requireSaved(d);
          if (d && d.ok && Array.isArray(d.groups)) {
            audioGroups = d.groups;
            renderAudioGroupPanel();
            refreshTaskEndAfterAudio();
          }
        }).catch(assetFailure);
      } catch (err) { assetFailure(err); }
    }
    function audioDeleteGroup(id) {
      var g = null;
      for (var i = 0; i < audioGroups.length; i++) if (audioGroups[i].id === id) {
        g = audioGroups[i];
        break;
      }
      showConfirm('确定删除音效组「' + (g ? g.name : id) + '」吗？', function () {
        try {
          fetch(AUDIO_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              action: 'delete-group',
              id: id
            })
          }).then(function (r) {
            return r.json();
          }).then(function (d) {
          requireSaved(d);
            if (d && d.ok && Array.isArray(d.groups)) {
              audioGroups = d.groups;
              renderAudioGroupPanel();
              refreshTaskEndAfterAudio();
              if (soundSet === id) setSoundSet('duck');
            }
          }).catch(assetFailure);
        } catch (err) { assetFailure(err); }
      });
    }
    var editingAudioGroupId = null;
    var activeSlotPanel = null;
    function audioSlotValue(slot) {
      return slot === 'press' ? audioEditPressVal || 'ya1' : audioEditReleaseVal || 'ya2';
    }
    var audioEditPressVal = 'ya1';
    var audioEditReleaseVal = 'ya2';
    function audioSlotName(id) {
      for (var i = 0; i < audioFragments.length; i++) if (audioFragments[i].id === id) return audioFragments[i].name;
      return id;
    }
    function audioSlotBtnText(btn, id) {
      try {
        var txt = audioSlotName(id);
        btn.style.opacity = txt ? '' : '.55';
        btn.textContent = txt || '留空·不发声';
        btn.title = '留空则该事件不发声;点击可选择音频片段';
      } catch (err) {}
      return btn;
    }
    function openAudioGroupEditor(group) {
      editingAudioGroupId = group && group.id ? group.id : null;
      audioEditTitle.textContent = editingAudioGroupId ? '编辑音效组' : '新建音效组';
      audioEditName.value = group && group.name ? group.name : '';
      var isNewGroup = !(group && group.id);
      audioEditPressVal = group && typeof group.press === 'string' ? group.press : isNewGroup ? '' : 'ya1';
      audioEditReleaseVal = group && typeof group.release === 'string' ? group.release : isNewGroup ? '' : 'ya2';
      audioEditPressBtn.textContent = audioSlotName(audioEditPressVal);
      audioEditReleaseBtn.textContent = audioSlotName(audioEditReleaseVal);
      audioSlotBtnText(audioEditPressBtn, audioEditPressVal);
      audioSlotBtnText(audioEditReleaseBtn, audioEditReleaseVal);
      audioEditPreviewEnsure();
      audioEditMask.style.display = 'flex';
    }
    function toggleAudioSlotPanel(slot) {
      var btn = slot === 'press' ? audioEditPressBtn : audioEditReleaseBtn;
      var panel = slot === 'press' ? audioEditPressPanel : audioEditReleasePanel;
      if (activeSlotPanel === panel) {
        closeAudioSlotPanels();
        return;
      }
      closeAudioSlotPanels();
      activeSlotPanel = panel;
      renderAudioSlotPanel(slot);
      try {
        var b = btn.getBoundingClientRect();
        var vp = viewport();
        var panelW = Math.max(120, Math.round(b.width));
        panel.style.width = panelW + 'px';
        panel.style.left = Math.max(4, Math.min(b.left, vp.w - panelW - 4)) + 'px';
        panel.style.top = b.bottom + 4 + 'px';
        panel.style.display = 'block';
      } catch (err) {}
    }
    function closeAudioSlotPanels() {
      if (audioEditPressPanel) audioEditPressPanel.style.display = 'none';
      if (audioEditReleasePanel) audioEditReleasePanel.style.display = 'none';
      activeSlotPanel = null;
    }
    function renderAudioSlotPanel(slot) {
      try {
        var panel = slot === 'press' ? audioEditPressPanel : audioEditReleasePanel;
        var current = slot === 'press' ? audioEditPressVal : audioEditReleaseVal;
        panel.innerHTML = '';
        var emptyItem = document.createElement('div');
        emptyItem.className = 'dshwv-audioitem' + (!current ? ' dshwv-audioitem-cur' : '');
        var emptyIcon = document.createElement('span');
        emptyIcon.className = 'dshwv-audiothumb';
        emptyIcon.textContent = '🚫';
        emptyItem.appendChild(emptyIcon);
        var emptyName = makeNameCell('dshwv-audioname', '留空（不发声）');
        emptyItem.appendChild(emptyName);
        emptyItem.addEventListener('click', function () {
          if (slot === 'press') {
            audioEditPressVal = '';
            audioSlotBtnText(audioEditPressBtn, '');
          } else {
            audioEditReleaseVal = '';
            audioSlotBtnText(audioEditReleaseBtn, '');
          }
          audioEditPreviewEnsure(true);
          closeAudioSlotPanels();
        });
        bindNameMarquee(emptyItem, emptyName);
        panel.appendChild(emptyItem);
        audioFragments.forEach(function (f) {
          var item = document.createElement('div');
          item.className = 'dshwv-audioitem' + (current === f.id ? ' dshwv-audioitem-cur' : '');
          var thumb = document.createElement('span');
          thumb.className = 'dshwv-audiothumb';
          thumb.textContent = '🎵';
          item.appendChild(thumb);
          var name = makeNameCell('dshwv-audioname', f.name);
          item.appendChild(name);
          if (f.preset) {
            var tag = document.createElement('span');
            tag.className = 'dshwv-audiopreset';
            tag.textContent = '预设';
            item.appendChild(tag);
          } else {
            var del = document.createElement('button');
            del.type = 'button';
            del.className = 'dshwv-audiodel';
            del.textContent = '✕';
            del.title = '删除该音频';
            del.addEventListener('click', function (e) {
              e.stopPropagation();
              audioDeleteFragmentInSlot(slot, f.id);
            });
            item.appendChild(del);
          }
          item.addEventListener('click', function () {
            if (slot === 'press') {
              audioEditPressVal = f.id;
              audioSlotBtnText(audioEditPressBtn, f.id);
            } else {
              audioEditReleaseVal = f.id;
              audioSlotBtnText(audioEditReleaseBtn, f.id);
            }
            audioEditPreviewEnsure(true);
            closeAudioSlotPanels();
          });
          bindNameMarquee(item, name);
          panel.appendChild(item);
        });
      } catch (err) {}
    }
    function hideAudioEditor() {
      stopAudioEditPreview();
      audioEditMask.style.display = 'none';
      editingAudioGroupId = null;
      closeAudioSlotPanels();
    }
    var audioEditPreviewEl = null;
    var audioEditPreviewRelease = null;
    var audioEditPreviewTimer = null;
    var audioEditPreviewReady = false;
    var audioEditPreviewPressing = false;
    var audioEditPreviewPressEnded = false;
    var audioEditPreviewReleasePlayed = false;
    function audioEditPreviewEnsure(force) {
      try {
        if (!force && audioEditPreviewReady) return true;
        var pressId = audioEditPressVal || '';
        var releaseId = audioEditReleaseVal || '';
        try {
          stopAudioEditPreview();
        } catch (err) {}
        try {
          if (audioEditPreviewEl) {
            audioEditPreviewEl.pause();
            audioEditPreviewEl = null;
          }
          if (audioEditPreviewRelease) {
            audioEditPreviewRelease.pause();
            audioEditPreviewRelease = null;
          }
        } catch (err) {}
        if (pressId) {
          audioEditPreviewEl = new Audio('/dsh-whale/audio-fragment.wav?id=' + encodeURIComponent(pressId));
          audioEditPreviewEl.preload = 'auto';
          audioEditPreviewEl.volume = soundVol;
        }
        if (releaseId) {
          audioEditPreviewRelease = new Audio('/dsh-whale/audio-fragment.wav?id=' + encodeURIComponent(releaseId));
          audioEditPreviewRelease.preload = 'auto';
          audioEditPreviewRelease.volume = soundVol;
        }
        audioEditPreviewReady = true;
        return true;
      } catch (err) {
        return false;
      }
    }
    function audioEditPreviewDown() {
      try {
        stopAudioEditPreview();
        if (!audioEditPreviewEnsure()) return;
        audioEditPreviewPressing = true;
        audioEditPreviewPressEnded = false;
        audioEditPreviewReleasePlayed = false;
        if (!audioEditPreviewEl) {
          audioEditPreviewPressEnded = true;
          return;
        }
        audioEditPreviewEl.onended = function () {
          audioEditPreviewPressEnded = true;
          if (!audioEditPreviewPressing && !audioEditPreviewReleasePlayed) audioEditPreviewUp();
        };
        var p = audioEditPreviewEl.play();
        if (p && typeof p.catch === 'function') p.catch(function () {});
      } catch (err) {}
    }
    function audioEditPreviewUp() {
      try {
        if (!audioEditPreviewPressing) return;
        audioEditPreviewPressing = false;
        if (!audioEditPreviewEl) {
          audioEditPreviewPlayRelease();
          return;
        }
        if (audioEditPreviewPressEnded) {
          audioEditPreviewPlayRelease();
          return;
        }
        var durKnown = false;
        var remainMs = 0;
        try {
          var dur = audioEditPreviewEl ? audioEditPreviewEl.duration : 0;
          if (isFinite(dur) && dur > 0) {
            durKnown = true;
            remainMs = (dur - audioEditPreviewEl.currentTime) * 1000;
          }
        } catch (err) {}
        if (durKnown) {
          audioEditPreviewTimer = setTimeout(function () {
            audioEditPreviewTimer = null;
            audioEditPreviewPlayRelease();
          }, Math.max(0, remainMs - 100));
        }
      } catch (err) {}
    }
    function audioEditPreviewPlayRelease() {
      try {
        if (audioEditPreviewReleasePlayed || !audioEditPreviewRelease) return;
        audioEditPreviewReleasePlayed = true;
        audioEditPreviewRelease.currentTime = 0;
        var p = audioEditPreviewRelease.play();
        if (p && typeof p.catch === 'function') p.catch(function () {});
      } catch (err) {}
    }
    function stopAudioEditPreview() {
      try {
        if (audioEditPreviewTimer) {
          clearTimeout(audioEditPreviewTimer);
          audioEditPreviewTimer = null;
        }
        if (audioEditPreviewEl) {
          audioEditPreviewEl.pause();
          audioEditPreviewEl.currentTime = 0;
        }
        if (audioEditPreviewRelease) {
          audioEditPreviewRelease.pause();
          audioEditPreviewRelease.currentTime = 0;
        }
        audioEditPreviewPressing = false;
        audioEditPreviewPressEnded = false;
        audioEditPreviewReleasePlayed = false;
      } catch (err) {}
    }
    function saveAudioGroup() {
      try {
        stopAudioEditPreview();
        var name = (audioEditName.value || '').trim().slice(0, 20);
        if (!name) {
          audioEditName.focus();
          return;
        }
        fetch(AUDIO_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            action: 'save-group',
            id: editingAudioGroupId || '',
            name: name,
            press: audioEditPressVal || '',
            release: audioEditReleaseVal || ''
          })
        }).then(function (r) {
          return r.json();
        }).then(function (d) {
          requireSaved(d);
          if (d && d.ok && Array.isArray(d.groups)) {
            audioGroups = d.groups;
            renderAudioGroupPanel();
            refreshTaskEndAfterAudio();
            if (!editingAudioGroupId) {
              var newest = d.groups.filter(function (x) {
                return !x.preset;
              }).sort(function (a, b) {
                return (b.pinnedAt || 0) - (a.pinnedAt || 0);
              })[0];
              if (newest) setSoundSet(newest.id);
            } else if (soundSet === editingAudioGroupId) {
              try {
                applySoundSet();
              } catch (err) { assetFailure(err); }
            }
            hideAudioEditor();
          }
        }).catch(assetFailure);
      } catch (err) { assetFailure(err); }
    }
    var audioCropFileInput = document.createElement('input');
    audioCropFileInput.type = 'file';
    audioCropFileInput.accept = 'audio/*';
    audioCropFileInput.style.display = 'none';
    document.body.appendChild(audioCropFileInput);
    var audioCropTarget = null;
    var audioCropCtx = null;
    var audioCropBuffer = null;
    var audioCropFileBase = '';
    var audioCropZoom = 1;
    var audioCropOffset = 0;
    audioEditPressImport.addEventListener('click', function () {
      audioCropTarget = 'press';
      audioCropFileInput.click();
    });
    audioEditReleaseImport.addEventListener('click', function () {
      audioCropTarget = 'release';
      audioCropFileInput.click();
    });
    audioCropFileInput.addEventListener('change', async function () {
      var f = audioCropFileInput.files && audioCropFileInput.files[0];
      audioCropFileInput.value = '';
      if (!f) return;
      try {
        await WhaleMediaGuard.validateAudioFile(f);
        openAudioCrop(await f.arrayBuffer(), f.name);
      } catch (err) { assetNotice(err.message); }
    });
    function openAudioCrop(arrayBuf, fileName) {
      try {
        audioCropFileBase = (fileName || '音频片段').replace(/.[^.]+$/, '');
        audioCropZoom = 1;
        audioCropOffset = 0;
        stopAudioCropPreview();
        if (!audioCropCtx) {
          try {
            audioCropCtx = new (window.AudioContext || window.webkitAudioContext)();
          } catch (err) {
            audioCropCtx = null;
          }
        }
        if (!audioCropCtx) {
          assetNotice('当前环境不支持音频解码');
          return;
        }
        audioCropCtx.decodeAudioData(arrayBuf, function (buf) {
          var policy = WhaleMediaGuard.getPolicy();
          if (!isFinite(buf.duration) || buf.duration <= 0 || buf.duration > policy.maxAudioSeconds ||
              buf.numberOfChannels > policy.maxAudioChannels || buf.sampleRate > policy.maxAudioSampleRate) {
            assetNotice('音频超出时长、声道或采样率限制，请选择较短的音频');
            return;
          }
          audioCropBuffer = buf;
          audioCropStart.value = '0';
          audioCropEnd.value = '100';
          audioCropStartNum.max = buf.duration.toFixed(3);
          audioCropEndNum.max = buf.duration.toFixed(3);
          audioCropZoomRange.value = '1';
          audioCropZoomNum.value = '1';
          drawAudioCrop();
          try {
            audioCropName.value = '';
          } catch (err) {}
          updateAudioCropOkState();
          audioCropMask.style.display = 'flex';
        }, function () {
          assetNotice('音频解码失败');
        });
      } catch (err) {}
    }
    function audioCropRange() {
      var b = audioCropBuffer;
      if (!b) return null;
      var s = Number(audioCropStart.value) / 100;
      var e = Number(audioCropEnd.value) / 100;
      if (e < s) {
        var t = s;
        s = e;
        e = t;
      }
      return {
        start: b.duration * s,
        end: b.duration * e,
        s: s,
        e: e
      };
    }
    function onAudioCropWheel(e) {
      if (!audioCropBuffer) return;
      try {
        e.preventDefault();
        e.stopPropagation();
      } catch (err) {}
      var maxOff = Math.max(0, 1 - 1 / audioCropZoom);
      if (maxOff <= 0) return;
      var dx = (e.deltaY || 0) + (e.deltaX || 0);
      if (dx === 0) return;
      var move = dx / audioCropCanvas.width / audioCropZoom;
      audioCropOffset = Math.min(maxOff, Math.max(0, audioCropOffset + move));
      drawAudioCrop();
    }
    // Canvas colors follow the theme's stylesheet variables.
    function themeColor(name, fallback) {
      try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback; } catch (err) { return fallback; }
    }
    function drawAudioCrop(skipSync) {
      try {
        if (!audioCropBuffer) return;
        var r = audioCropRange();
        audioCropTime.textContent = r.start.toFixed(1) + 's – ' + r.end.toFixed(1) + 's' + '（共 ' + audioCropBuffer.duration.toFixed(1) + 's，缩放 x' + audioCropZoom.toFixed(1) + '）';
        var ctx = audioCropCanvas.getContext('2d');
        var W = audioCropCanvas.width, H = audioCropCanvas.height;
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = themeColor('--surface-2', '#f3f5fb');
        ctx.fillRect(0, 0, W, H);
        var ch = audioCropBuffer.getChannelData(0);
        var totalLen = ch.length;
        var viewStart = audioCropOffset;
        var viewSpan = 1 / audioCropZoom;
        ctx.strokeStyle = themeColor('--ink-3', '#9fb0d9');
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (var x = 0; x < W; x++) {
          var g0 = viewStart + x / W * viewSpan;
          var g1 = viewStart + (x + 1) / W * viewSpan;
          var i0 = Math.max(0, Math.floor(g0 * totalLen));
          var i1 = Math.max(i0 + 1, Math.min(totalLen - 1, Math.ceil(g1 * totalLen)));
          var mn = 0, mx = 0;
          for (var i = i0; i < i1; i++) {
            var v = ch[i];
            if (v < mn) mn = v;
            if (v > mx) mx = v;
          }
          var yTop = H / 2 - mx * H / 2;
          var yBot = H / 2 - mn * H / 2;
          ctx.moveTo(x, yTop);
          ctx.lineTo(x, yBot);
        }
        ctx.stroke();
        var vx0 = (r.s - viewStart) / viewSpan * W;
        var vx1 = (r.e - viewStart) / viewSpan * W;
        var drawX0 = Math.max(0, vx0);
        var drawX1 = Math.min(W, vx1);
        if (drawX1 > drawX0) {
          ctx.fillStyle = themeColor('--accent-soft', 'rgba(32,49,112,.25)');
          ctx.fillRect(drawX0, 0, drawX1 - drawX0, H);
          ctx.strokeStyle = themeColor('--accent', '#203170');
          ctx.lineWidth = 2;
          ctx.strokeRect(drawX0 + 0.5, 0.5, drawX1 - drawX0, H - 1);
        }
        ctx.strokeStyle = themeColor('--line-strong', 'rgba(32,49,112,.3)');
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, H - 1);
        ctx.lineTo(W, H - 1);
        ctx.stroke();
        if (!skipSync) {
          audioCropStartNum.value = r.start.toFixed(3);
          audioCropEndNum.value = r.end.toFixed(3);
          audioCropZoomRange.value = String(audioCropZoom);
          audioCropZoomNum.value = String(Math.round(audioCropZoom * 100) / 100);
        }
        try {
          var trackW = audioCropDual.clientWidth || 200;
          var usable = Math.max(1, trackW - 8);
          audioCropDualStart.style.left = 4 + r.s * usable + 'px';
          audioCropDualEnd.style.left = 4 + r.e * usable + 'px';
          audioCropDualFill.style.left = 4 + r.s * usable + 'px';
          audioCropDualFill.style.width = Math.max(0, (r.e - r.s) * usable) + 'px';
        } catch (err) {}
      } catch (err) {}
    }
    function onAudioCropStartInput() {
      syncAudioCropStartNum();
      drawAudioCrop();
    }
    function syncAudioCropStartNum() {
      var b = audioCropBuffer;
      if (!b) return;
      audioCropStartNum.value = (b.duration * Number(audioCropStart.value) / 100).toFixed(3);
    }
    function onAudioCropEndInput() {
      syncAudioCropEndNum();
      drawAudioCrop();
    }
    function syncAudioCropEndNum() {
      var b = audioCropBuffer;
      if (!b) return;
      audioCropEndNum.value = (b.duration * Number(audioCropEnd.value) / 100).toFixed(3);
    }
    function onAudioCropStartNumInput() {
      var b = audioCropBuffer;
      if (!b) return;
      var v = Number(audioCropStartNum.value);
      if (!isFinite(v)) return;
      v = Math.min(Math.max(0, v), b.duration);
      var endSec = b.duration * Number(audioCropEnd.value) / 100;
      if (v > endSec - 0.001) v = Math.max(0, endSec - 0.001);
      audioCropStart.value = String(v / b.duration * 100);
      drawAudioCrop(true);
    }
    function onAudioCropStartNumChange() {
      var b = audioCropBuffer;
      if (!b) return;
      var v = Number(audioCropStartNum.value);
      if (!isFinite(v)) v = 0;
      v = Math.min(Math.max(0, v), b.duration);
      var endSec = b.duration * Number(audioCropEnd.value) / 100;
      if (v > endSec - 0.001) v = Math.max(0, endSec - 0.001);
      audioCropStart.value = String(v / b.duration * 100);
      drawAudioCrop();
    }
    function onAudioCropEndNumInput() {
      var b = audioCropBuffer;
      if (!b) return;
      var v = Number(audioCropEndNum.value);
      if (!isFinite(v)) return;
      v = Math.min(Math.max(0, v), b.duration);
      var startSec = b.duration * Number(audioCropStart.value) / 100;
      if (v < startSec + 0.001) v = Math.min(b.duration, startSec + 0.001);
      audioCropEnd.value = String(v / b.duration * 100);
      drawAudioCrop(true);
    }
    function onAudioCropEndNumChange() {
      var b = audioCropBuffer;
      if (!b) return;
      var v = Number(audioCropEndNum.value);
      if (!isFinite(v)) v = b.duration;
      v = Math.min(Math.max(0, v), b.duration);
      var startSec = b.duration * Number(audioCropStart.value) / 100;
      if (v < startSec + 0.001) v = Math.min(b.duration, startSec + 0.001);
      audioCropEnd.value = String(v / b.duration * 100);
      drawAudioCrop();
    }
    function applyAudioCropZoom(v, skipSync) {
      if (!audioCropBuffer) return;
      var next = Number(v);
      if (!isFinite(next) || next < 1) next = 1;
      if (next > 50) next = 50;
      var r = audioCropRange();
      var mid = (r.s + r.e) / 2;
      var viewSpan = 1 / audioCropZoom;
      var midInView = viewSpan > 0 ? (mid - audioCropOffset) / viewSpan : 0.5;
      audioCropZoom = next;
      var newSpan = 1 / audioCropZoom;
      audioCropOffset = mid - midInView * newSpan;
      audioCropOffset = Math.min(1 - 1 / audioCropZoom, Math.max(0, audioCropOffset));
      audioCropZoomRange.value = String(audioCropZoom);
      audioCropZoomNum.value = String(Math.round(audioCropZoom * 100) / 100);
      drawAudioCrop(skipSync);
    }
    function onAudioCropZoomInput() {
      applyAudioCropZoom(audioCropZoomRange.value);
    }
    function onAudioCropZoomNumInput() {
      var v = Number(audioCropZoomNum.value);
      if (!isFinite(v) || v < 1) return;
      if (v > 50) return;
      applyAudioCropZoom(v, true);
    }
    function onAudioCropZoomNumChange() {
      applyAudioCropZoom(audioCropZoomNum.value);
    }
    var audioCropSelDrag = null;
    function onAudioCropSelDown(e) {
      if (!audioCropBuffer) return;
      try {
        e.preventDefault();
        e.stopPropagation();
      } catch (err) {}
      var rect = audioCropCanvas.getBoundingClientRect();
      var W = audioCropCanvas.width;
      var globalRatio = audioCropOffset + (e.clientX - rect.left) / W * (1 / audioCropZoom);
      globalRatio = Math.min(1, Math.max(0, globalRatio));
      audioCropSelDrag = {
        startRatio: globalRatio,
        moved: false
      };
      audioCropStart.value = String(globalRatio * 100);
      syncAudioCropStartNum();
      drawAudioCrop();
    }
    function onAudioCropSelMove(e) {
      if (!audioCropSelDrag || !audioCropBuffer) return;
      var rect = audioCropCanvas.getBoundingClientRect();
      var W = audioCropCanvas.width;
      var globalRatio = audioCropOffset + (e.clientX - rect.left) / W * (1 / audioCropZoom);
      globalRatio = Math.min(1, Math.max(0, globalRatio));
      if (Math.abs(globalRatio - audioCropSelDrag.startRatio) > 0.002) audioCropSelDrag.moved = true;
      if (audioCropSelDrag.moved) {
        var s = Math.min(audioCropSelDrag.startRatio, globalRatio);
        var en = Math.max(audioCropSelDrag.startRatio, globalRatio);
        audioCropStart.value = String(s * 100);
        audioCropEnd.value = String(en * 100);
        syncAudioCropStartNum();
        syncAudioCropEndNum();
        drawAudioCrop();
      }
    }
    function onAudioCropSelUp() {
      audioCropSelDrag = null;
    }
    var audioCropDualDrag = null;
    function onAudioCropDualDown(e) {
      if (!audioCropBuffer) return;
      try {
        e.preventDefault();
        e.stopPropagation();
      } catch (err) {}
      var ratio = audioCropDualRatio(e);
      var startV = Number(audioCropStart.value) / 100;
      var endV = Number(audioCropEnd.value) / 100;
      var dStart = Math.abs(ratio - startV);
      var dEnd = Math.abs(ratio - endV);
      audioCropDualDrag = {
        side: dStart <= dEnd ? 'start' : 'end'
      };
      audioCropDualMoveTo(ratio);
    }
    function onAudioCropDualMove(e) {
      if (!audioCropDualDrag || !audioCropBuffer) return;
      audioCropDualMoveTo(audioCropDualRatio(e));
    }
    function audioCropDualRatio(e) {
      var rect = audioCropDual.getBoundingClientRect();
      var usable = Math.max(1, rect.width - 8);
      var ratio = (e.clientX - rect.left - 4) / usable;
      return Math.min(1, Math.max(0, ratio));
    }
    function audioCropDualMoveTo(ratio) {
      if (!audioCropDualDrag) return;
      var startV = Number(audioCropStart.value) / 100;
      var endV = Number(audioCropEnd.value) / 100;
      if (audioCropDualDrag.side === 'start') {
        if (ratio >= endV) ratio = Math.max(0, endV - 0.0001);
        audioCropStart.value = String(ratio * 100);
        syncAudioCropStartNum();
      } else {
        if (ratio <= startV) ratio = Math.min(1, startV + 0.0001);
        audioCropEnd.value = String(ratio * 100);
        syncAudioCropEndNum();
      }
      drawAudioCrop();
    }
    function onAudioCropDualUp() {
      audioCropDualDrag = null;
    }
    function hideAudioCrop() {
      stopAudioCropPreview();
      audioCropMask.style.display = 'none';
      audioCropBuffer = null;
      audioCropTarget = null;
      audioCropFileBase = '';
      try {
        audioCropName.value = '';
      } catch (err) {}
      updateAudioCropOkState();
    }
    var audioCropPreviewNode = null;
    function stopAudioCropPreview() {
      try {
        if (audioCropPreviewNode) {
          audioCropPreviewNode.stop();
          audioCropPreviewNode.disconnect();
          audioCropPreviewNode = null;
        }
      } catch (err) {}
    }
    function previewAudioCrop() {
      try {
        if (!audioCropBuffer || !audioCropCtx) return;
        stopAudioCropPreview();
        var r = audioCropRange();
        var len = Math.floor((r.end - r.start) * audioCropBuffer.sampleRate);
        if (len < 1) return;
        var slice = audioCropCtx.createBuffer(audioCropBuffer.numberOfChannels, len, audioCropBuffer.sampleRate);
        for (var c = 0; c < audioCropBuffer.numberOfChannels; c++) {
          var src = audioCropBuffer.getChannelData(c);
          var dst = slice.getChannelData(c);
          var off = Math.floor(r.start * audioCropBuffer.sampleRate);
          for (var i = 0; i < len; i++) dst[i] = src[off + i] || 0;
        }
        var srcNode = audioCropCtx.createBufferSource();
        srcNode.buffer = slice;
        srcNode.connect(audioCropCtx.destination);
        audioCropPreviewNode = srcNode;
        srcNode.onended = function () {
          if (audioCropPreviewNode === srcNode) audioCropPreviewNode = null;
        };
        srcNode.start();
      } catch (err) {}
    }
    function encodeWav(buffer) {
      var numCh = buffer.numberOfChannels;
      var sampleRate = buffer.sampleRate;
      var len = buffer.length;
      var bytesPerSample = 2;
      var blockAlign = numCh * bytesPerSample;
      var dataSize = len * blockAlign;
      var ab = new ArrayBuffer(44 + dataSize);
      var dv = new DataView(ab);
      function writeStr(offset, s) {
        for (var i = 0; i < s.length; i++) dv.setUint8(offset + i, s.charCodeAt(i));
      }
      writeStr(0, 'RIFF');
      dv.setUint32(4, 36 + dataSize, true);
      writeStr(8, 'WAVE');
      writeStr(12, 'fmt ');
      dv.setUint32(16, 16, true);
      dv.setUint16(20, 1, true);
      dv.setUint16(22, numCh, true);
      dv.setUint32(24, sampleRate, true);
      dv.setUint32(28, sampleRate * blockAlign, true);
      dv.setUint16(32, blockAlign, true);
      dv.setUint16(34, 16, true);
      writeStr(36, 'data');
      dv.setUint32(40, dataSize, true);
      var offset = 44;
      for (var i = 0; i < len; i++) {
        for (var c = 0; c < numCh; c++) {
          var v = buffer.getChannelData(c)[i];
          var s = Math.max(-1, Math.min(1, v));
          dv.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
          offset += 2;
        }
      }
      return new Blob([ab], {
        type: 'audio/wav'
      });
    }
    function confirmAudioCrop() {
      try {
        if (!audioCropBuffer) return;
        stopAudioCropPreview();
        var fragName = String(audioCropName.value || '').trim();
        if (!fragName) {
          try {
            audioCropName.classList.add('dshwv-invalid');
            audioCropName.focus();
            setTimeout(function () {
              audioCropName.classList.remove('dshwv-invalid');
            }, 1200);
          } catch (err) {}
          return;
        }
        var r = audioCropRange();
        var len = Math.floor((r.end - r.start) * audioCropBuffer.sampleRate);
        if (len < 1) {
          assetNotice('所选片段为空');
          return;
        }
        if (44 + len * audioCropBuffer.numberOfChannels * 2 > WhaleMediaGuard.getPolicy().audioBytes) {
          assetNotice('所选音频片段过大，请缩短后再保存');
          return;
        }
        var slice = audioCropCtx.createBuffer(audioCropBuffer.numberOfChannels, len, audioCropBuffer.sampleRate);
        for (var c = 0; c < audioCropBuffer.numberOfChannels; c++) {
          var src = audioCropBuffer.getChannelData(c);
          var dst = slice.getChannelData(c);
          var off = Math.floor(r.start * audioCropBuffer.sampleRate);
          for (var i = 0; i < len; i++) dst[i] = src[off + i] || 0;
        }
        var blob = encodeWav(slice);
        WhaleMediaGuard.checkFile(blob, 'wav');
        var reader = new FileReader();
        reader.onload = function () {
          uploadAudioFragment(reader.result, fragName, function (ok) {
            if (ok) {
              if (audioCropTarget === 'press') {
                audioEditPressVal = lastUploadedFragmentId || audioEditPressVal;
                audioSlotBtnText(audioEditPressBtn, audioEditPressVal);
              } else if (audioCropTarget === 'release') {
                audioEditReleaseVal = lastUploadedFragmentId || audioEditReleaseVal;
                audioSlotBtnText(audioEditReleaseBtn, audioEditReleaseVal);
              }
              audioEditPreviewEnsure(true);
              hideAudioCrop();
            }
          });
        };
        reader.onerror = function () { assetNotice('音频读取失败，请重试'); };
        reader.readAsDataURL(blob);
      } catch (err) { assetNotice(err.message); }
    }
    var lastUploadedFragmentId = null;
    function uploadAudioFragment(dataUrl, name, cb) {
      try {
        fetch(AUDIO_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            action: 'upload-fragment',
            name: name,
            audio: dataUrl
          })
        }).then(function (r) {
          return r.json();
        }).then(function (d) {
          requireSaved(d);
          if (d && d.ok && Array.isArray(d.fragments)) {
            audioFragments = d.fragments;
            lastUploadedFragmentId = d.id || null;
            refreshTaskEndAfterAudio();
            if (cb) cb(true);
          } else {
            if (cb) cb(false);
          }
        }).catch(function (error) {
          assetFailure(error);
          if (cb) cb(false);
        });
      } catch (err) {
        if (cb) cb(false);
      }
    }
    function audioDeleteFragmentInSlot(slot, id) {
      if (!id) return;
      var f = null;
      for (var i = 0; i < audioFragments.length; i++) if (audioFragments[i].id === id) {
        f = audioFragments[i];
        break;
      }
      if (!f || f.preset) return;
      showConfirm('确定删除音频「' + f.name + '」吗？', function () {
        try {
          fetch(AUDIO_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              action: 'delete-fragment',
              id: id
            })
          }).then(function (r) {
            return r.json();
          }).then(function (d) {
          requireSaved(d);
            if (d && d.ok && Array.isArray(d.fragments)) {
              audioFragments = d.fragments;
              if (Array.isArray(d.groups)) audioGroups = d.groups;
              if (slot === 'press' && audioEditPressVal === id) {
                audioEditPressVal = 'ya1';
                audioSlotBtnText(audioEditPressBtn, 'ya1');
              }
              if (slot === 'release' && audioEditReleaseVal === id) {
                audioEditReleaseVal = 'ya2';
                audioSlotBtnText(audioEditReleaseBtn, 'ya2');
              }
              audioEditPreviewEnsure(true);
              renderAudioGroupPanel();
              if (activeSlotPanel) renderAudioSlotPanel(slot);
              refreshTaskEndAfterAudio();
            }
          }).catch(assetFailure);
        } catch (err) { assetFailure(err); }
      });
    }
    audioEditPressBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleAudioSlotPanel('press');
    });
    audioEditReleaseBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleAudioSlotPanel('release');
    });

    function setupHitTest(url) {
      WhaleRendering.hitCache.prepare(url || IMG_URL);
    }
    function whaleLayoutRect() {
      var origin = positioner.getBoundingClientRect();
      var width = root.offsetWidth, height = root.offsetHeight;
      return { left: origin.left, top: origin.top, right: origin.left + width, bottom: origin.top + height, width: width, height: height };
    }
    function isWhaleHit(e) {
      return !!e && WhaleRendering.hitCache.hit(img, e.clientX, e.clientY, WhaleRendering.mirrorScale(root) < 0);
    }
    function onDocPointerDown(e) {
      if (e.target && e.target.closest) {
        if (e.target.closest('.chat-composer,.chat-reply,dialog')) return;
        if (e.target.closest('.dshwv-pop') || e.target.closest('.dshwv-menu-btn')) return;
        if (e.target.closest('.dshwv-rolelist') || e.target.closest('.dshwv-audiolist') || e.target.closest('.dshwv-cropmask') || e.target.closest('.dshwv-confirmmask') || e.target.closest('.dshwv-audiomask') || e.target.closest('.dshwv-snapmask') || e.target.closest('.dshwv-usagepanel') || e.target.closest('.dshwv-usage-mask') || e.target.closest('.dshwv-resmask') || e.target.closest('.dshwv-custmenu') || e.target.closest('.dshwv-custbtn') || e.target.closest('.dshwv-fxinfo') || e.target.closest('.dshwv-fxicon')) return;
        if (e.target.closest('.dshwv-rolebtn') || e.target.closest('.dshwv-audiobtn') || e.target.closest('.dshwv-roleimport') || e.target.closest('.dshwv-audioimport')) return;
        if (e.target.closest('.dshwv-menu')) {
          closeRolePanel();
          closeAudioGroupPanel();
          return;
        }
      }
      if (menuOpen) {
        closeMenu();
        return;
      }
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      if (!isWhaleHit(e)) return;
      try {
        e.preventDefault();
        e.stopPropagation();
      } catch (err) {}
      var vp = viewport();
      var rect = positioner.getBoundingClientRect();
      try { root.setPointerCapture(e.pointerId); } catch (err) {}
    drag = {
        active: true,
        startX: e.clientX,
        startY: e.clientY,
        origLeft: rect.left,
        origTop: rect.top,
        w: root.offsetWidth,
        h: root.offsetHeight,
        moved: false,
        vp: vp
      };
      root.classList.add('dshwv-dragging');
      positioner.style.transition = 'none';
      pressDown();
      setWidgetCursor('grabbing');
      document.addEventListener('pointermove', onDocPointerMove, true);
      document.addEventListener('pointerup', onDocPointerUp, true);
      document.addEventListener('pointercancel', onDocPointerCancel, true);
    }
    function onDocPointerMove(e) {
      if (!drag || !drag.active) return;
      var dx = e.clientX - drag.startX;
      var dy = e.clientY - drag.startY;
      if (dx * dx + dy * dy >= CLICK_SQ) drag.moved = true;
      state.left = clamp(drag.origLeft + dx, 0, Math.max(0, drag.vp.w - drag.w));
      state.top = clamp(drag.origTop + dy, topMin(drag.h), Math.max(0, drag.vp.h - drag.h));
      express();
    }
    function onDocPointerUp(e) {
      try {
        if (isWhaleHit(e)) {
          e.preventDefault();
          e.stopPropagation();
        }
      } catch (err) {}
      endDrag(e, true);
    }
    function onDocPointerCancel(e) {
      endDrag(e, false);
    }
    function onDocClickStopper(e) {
      if (e.target && e.target.closest) {
        if (e.target.closest('.chat-composer,.chat-reply,dialog')) return;
        if (e.target.closest('.dshwv-pop') || e.target.closest('.dshwv-menu') || e.target.closest('.dshwv-menu-btn') || e.target.closest('.dshwv-rolelist') || e.target.closest('.dshwv-cropmask') || e.target.closest('.dshwv-confirmmask') || e.target.closest('.dshwv-audiolist') || e.target.closest('.dshwv-audiomask') || e.target.closest('.dshwv-snapmask') || e.target.closest('.dshwv-usagepanel') || e.target.closest('.dshwv-usage-mask') || e.target.closest('.dshwv-resmask') || e.target.closest('.dshwv-custmenu') || e.target.closest('.dshwv-custbtn') || e.target.closest('.dshwv-fxinfo') || e.target.closest('.dshwv-fxicon')) return;
      }
      if (!isWhaleHit(e)) return;
      try {
        e.preventDefault();
        e.stopPropagation();
      } catch (err) {}
    }
    function onDocContextMenu(e) {
      try {
        if (e.target && e.target.closest('.chat-composer,.chat-reply,dialog')) return;
        if (e.target && e.target.closest) {
          if (e.target.closest('.dshwv-pop') || e.target.closest('.dshwv-menu') || e.target.closest('.dshwv-menu-btn') || e.target.closest('.dshwv-rolelist') || e.target.closest('.dshwv-audiolist') || e.target.closest('.dshwv-cropmask') || e.target.closest('.dshwv-confirmmask') || e.target.closest('.dshwv-audiomask') || e.target.closest('.dshwv-snapmask') || e.target.closest('.dshwv-usagepanel') || e.target.closest('.dshwv-usage-mask') || e.target.closest('.dshwv-resmask') || e.target.closest('.dshwv-custmenu') || e.target.closest('.dshwv-custbtn')) return;
        }
        if (!isWhaleHit(e)) return;
        e.preventDefault();
        if (e.shiftKey) { toggleMenu(); return; }
        closeMenu();
        window.dispatchEvent(new Event('whale-chat-open'));
      } catch (err) {}
    }
    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('click', onDocClickStopper, true);
    document.addEventListener('contextmenu', onDocContextMenu, true);
    window.addEventListener('whale-companion-move', function (e) {
      var delta = Number(e.detail && e.detail.y);
      if (!isFinite(delta)) return;
      // Reserve space using the final position, avoiding repeated corrections
      // based on the intermediate frames of a positioning transition.
      var transition = positioner.style.transition;
      positioner.style.transition = 'none';
      state.top = clamp(state.top + delta, topMin(root.offsetHeight), Math.max(0, viewport().h - root.offsetHeight));
      express();
      positioner.getBoundingClientRect();
      positioner.style.transition = transition;
    });
    window.addEventListener('whale-companion-reply', function () {
      if (bubbleScene && bubbleScene.kind === 'approval') return;
      hideBubble();
    });
    var widgetCursor = '';
    function setWidgetCursor(v) {
      if (v !== widgetCursor) {
        widgetCursor = v;
        try {
          document.body.style.cursor = v;
        } catch (err) {}
      }
    }
    function onDocPointerMoveCursor(e) {
      if (drag && drag.active) {
        setWidgetCursor('grabbing');
        return;
      }
      var el = null;
      try {
        el = document.elementFromPoint(e.clientX, e.clientY);
      } catch (err) {}
      if (el && el.closest && (el.closest('.dshwv-pop') || el.closest('.dshwv-menu') || el.closest('.dshwv-menu-btn') || el.closest('.dshwv-rolelist') || el.closest('.dshwv-cropmask') || el.closest('.dshwv-confirmmask') || el.closest('.dshwv-audiolist') || el.closest('.dshwv-audiomask') || el.closest('.dshwv-snapmask') || el.closest('.dshwv-usagepanel') || el.closest('.dshwv-usage-mask') || el.closest('.dshwv-resmask') || el.closest('.dshwv-custmenu') || el.closest('.dshwv-custbtn') || el.closest('.dshwv-fxinfo') || el.closest('.dshwv-fxicon'))) {
        setWidgetCursor('');
        if (!menuBtnHide) menuBtn.classList.add('dshwv-menu-btn-visible');
        return;
      }
      var over = isWhaleHit(e);
      setWidgetCursor(over ? 'grab' : '');
      if (!menuBtnHide) menuBtn.classList.toggle('dshwv-menu-btn-visible', over || menuOpen);
    }
    document.addEventListener('pointermove', onDocPointerMoveCursor, true);
    document.addEventListener('mousemove', onDocPointerMoveCursor, true);
    window.addEventListener('whale-hover', function (e) { onDocPointerMoveCursor({ clientX: e.detail.x, clientY: e.detail.y }); });
    root.addEventListener('lostpointercapture', function (e) { endDrag(e, false); });
    window.addEventListener('blur', function () { endDrag(null, false); });
    function endDrag(e, clickAllowed) {
      if (!drag || !drag.active) return;
      drag.active = false;
    try { if (e && root.hasPointerCapture(e.pointerId)) root.releasePointerCapture(e.pointerId); } catch (err) {}
      document.removeEventListener('pointermove', onDocPointerMove, true);
      document.removeEventListener('pointerup', onDocPointerUp, true);
      document.removeEventListener('pointercancel', onDocPointerCancel, true);
      pressUp();
      root.classList.remove('dshwv-dragging');
      positioner.style.transition = '';
      setWidgetCursor(isWhaleHit(e) ? 'grab' : '');
      if (clickAllowed && !drag.moved) {
        whaleClick();
        refresh(true);
        return;
      }
      e = e && Number.isFinite(e.clientX) ? e : { clientX: drag.startX + state.left - drag.origLeft, clientY: drag.startY + state.top - drag.origTop };
      var dx = e.clientX - drag.startX;
      var dy = e.clientY - drag.startY;
      var left = clamp(drag.origLeft + dx, 0, Math.max(0, drag.vp.w - drag.w));
      var top = clamp(drag.origTop + dy, topMin(drag.h), Math.max(0, drag.vp.h - drag.h));
      var ac = artCenterAt(left, top, drag.w, drag.h, !!state.flip);
      var z = snapZones(ac.cx, top + drag.h / 2, ac.cy, drag.vp);
      if (z.zH === 'left') {
        state.h = 'left';
        state.hOff = 0;
      } else if (z.zH === 'right') {
        state.h = 'right';
        state.hOff = 0;
      } else {
        state.h = null;
        state.hOff = left;
      }
      if (z.zV === 'top') {
        state.v = 'top';
        top = state.vOff = topMin(drag.h);
      } else if (z.zV === 'bottom') {
        state.v = 'bottom';
        state.vOff = 0;
      } else {
        state.v = null;
        state.vOff = top;
      }
      state.flip = z.zH === 'left' ? true : z.zH === 'right' ? false : z.flip;
      state.left = left;
      state.top = top;
      settle();
      saveConfig();
    }
    function applyAnchorPos() {
      try {
        var a = JSON.parse(localStorage.getItem('dshw-pos') || 'null');
        if (!a || a.v !== 2 || a.hAnchor !== 'left' && a.hAnchor !== 'right' || typeof a.hDist !== 'number' || a.vAnchor !== 'top' && a.vAnchor !== 'bottom' || typeof a.vDist !== 'number') return false;
        var vp = viewport();
        var w = root.offsetWidth || root.getBoundingClientRect().width || 0;
        var h = root.offsetHeight || root.getBoundingClientRect().height || 0;
        var effectiveRightDist = a.hAnchor === 'right' ? a.hDist + (scrollGapOn ? rightGap() : 0) : a.hDist;
        var l = a.hAnchor === 'left' ? a.hDist : vp.w - effectiveRightDist - w;
        var t = a.vAnchor === 'top' ? a.vDist : vp.h - a.vDist - h;
        state.left = clamp(l, 0, Math.max(0, vp.w - w));
        state.top = clamp(t, topMin(h), Math.max(0, vp.h - h));
        state.h = a.hAnchor;
        state.hOff = a.hDist;
        state.v = a.vAnchor;
        state.vOff = a.vDist;
        refreshFlip();
        return true;
      } catch (err) {
        return false;
      }
    }
    window.addEventListener('resize', function () {
      if (state.h === null && state.v === null && applyAnchorPos()) return;
      settle();
    });
    var rect0 = root.getBoundingClientRect();
    state.left = rect0.left;
    state.top = rect0.top;
    express();
    applySoundSet();
    setupHitTest(initRoleUrl);
    loadRoles();
    loadAudio();
    loadUsageSettings(function () {
      try {
        if (usageSet && usageSet.taskEnd) {
          taskEndToggle.checked = !!usageSet.taskEnd.on;
          taskEndSel.disabled = !usageSet.taskEnd.on;
        }
        if (usageSet && usageSet.approvalSound) {
          approvalSoundToggle.checked = !!usageSet.approvalSound.on;
          approvalSoundSel.disabled = !usageSet.approvalSound.on;
        }
        if (usageSet && usageSet.pomodoroSound) {
          pomodoroSoundToggle.checked = !!usageSet.pomodoroSound.on;
          pomodoroSoundSel.disabled = !usageSet.pomodoroSound.on;
        }
        if (usageSet && usageSet.outcomeNotice) {
          failedNoticeToggle.checked = usageSet.outcomeNotice.failed !== false;
          cancelledNoticeToggle.checked = usageSet.outcomeNotice.cancelled !== false;
        }
        fillTaskEndOptions(usageSet && usageSet.taskEnd);
        fillReminderSoundOptions(approvalSoundSel, approvalSoundDrop, 'approvalSound', usageSet && usageSet.approvalSound);
        fillReminderSoundOptions(pomodoroSoundSel, pomodoroSoundDrop, 'pomodoroSound', usageSet && usageSet.pomodoroSound);
        setTimeout(function () {
          try {
            if (audioFragments && audioFragments.length) refreshTaskEndAfterAudio();
          } catch (err) {}
        }, 1500);
      } catch (err) {}
    });
    if (window.whaleDesktop && window.whaleDesktop.testMode) {
      window.__whaleRenderTest = Object.freeze({
        refresh: refresh, next: bubbleNext, close: hideBubble,
        poll: pollCompletions, importRole: onRoleFileChosen,
        showCost: showCostBubble,
        open: whaleClick,
        place: function (x, y, flip) { state.left = x; state.top = y; state.flip = !!flip; express(); },
        scale: setScale, role: applyRole,
        status: function () { return { switching: bubbleFrames.switching, busy: busy, shown: bubbleShown, scene: bubbleScene && bubbleScene.kind, epoch: bubbleSceneEpoch, balance: state.balance, today: state.todayUsage, status: state.status, account: quotaAccount && quotaAccount.id, front: bubbleFrames.front.root.dataset.buffer, text: bubbleFrames.front.root.innerText, hitCache: Object.assign({}, WhaleRendering.hitCache.stats), scale: state.scale, flip: state.flip }; }
      });
    }
    usageClient.migrateChoice().then(function (result) { if (result) refresh(false); });
    fetch(SIZE_URL, {
      cache: 'no-store'
    }).then(function (r) {
      return r.json();
    }).then(function (d) {
      if (d && typeof d.scale === 'number' && d.scale >= MIN_SCALE - 0.1 && d.scale <= MAX_SCALE + 0.1) {
        state.scale = d.scale;
        root.style.setProperty('--dshw-scale', String(d.scale));
        scaleInput.value = String(d.scale);
        paintRange(scaleInput);
        scaleNumber.value = String(scaleToDisplay(d.scale));
        settle();
      }
      if (d && typeof d.vol === 'number') {
        soundVol = d.vol;
        soundOn = soundVol > 0;
        volInput.value = String(soundVol);
        paintRange(volInput);
        volPct.textContent = Math.round(soundVol * 100) + '%';
        try {
          if (pressAudio) pressAudio.volume = soundVol;
          if (releaseAudio) releaseAudio.volume = soundVol;
        } catch (err) {}
      }
      if (d && typeof d.soundSet === 'string' && d.soundSet) {
        soundSet = d.soundSet;
        setAudioBtnText(audioGroupName(soundSet));
        applySoundSet();
      }
      if (d && typeof d.usageMode === 'string') {
        usageMode = 'ledger';
      }
      if (d && typeof d.bubbleOn === 'boolean') {
        bubbleOn = d.bubbleOn;
        bubbleToggle.checked = bubbleOn;
      }
      if (d && typeof d.turnCostOn === 'boolean') {
        turnCostOn = d.turnCostOn;
        turnCostToggle.checked = turnCostOn;
        turnCostCloseInput.disabled = !turnCostOn;
      }
      if (d && typeof d.turnCostCloseMs === 'number') {
        turnCostCloseMs = d.turnCostCloseMs > 0 ? d.turnCostCloseMs : 0;
        turnCostCloseInput.value = String(Math.round(turnCostCloseMs / 1000));
      }
      if (d && typeof d.scrollGapOn === 'boolean') {
        scrollGapOn = d.scrollGapOn;
        scrollGapToggle.checked = scrollGapOn;
        scrollGapInput.disabled = !scrollGapOn;
      }
      if (d && typeof d.scrollGapPx === 'number') {
        scrollGapPx = d.scrollGapPx > 0 ? Math.round(d.scrollGapPx) : 0;
        scrollGapInput.value = String(scrollGapPx);
      }
      if (d && typeof d.menuBtnHide === 'boolean') {
        menuBtnHide = d.menuBtnHide;
        if (menuHideToggle) menuHideToggle.checked = menuBtnHide;
        applyMenuBtnHideUI();
      }
      try {
        var a = JSON.parse(localStorage.getItem('dshw-pos') || 'null');
        if (a && a.v === 2 && (a.hAnchor === 'left' || a.hAnchor === 'right') && typeof a.hDist === 'number' && (a.vAnchor === 'top' || a.vAnchor === 'bottom') && typeof a.vDist === 'number') {
          var vpA = viewport();
          var wA = root.offsetWidth || root.getBoundingClientRect().width || 0;
          var hA = root.offsetHeight || root.getBoundingClientRect().height || 0;
          var effectiveRightDist = a.hAnchor === 'right' ? a.hDist + (scrollGapOn ? rightGap() : 0) : a.hDist;
          var lA = a.hAnchor === 'left' ? a.hDist : vpA.w - effectiveRightDist - wA;
          var tA = a.vAnchor === 'top' ? a.vDist : vpA.h - a.vDist - hA;
          state.left = clamp(lA, 0, Math.max(0, vpA.w - wA));
          state.top = clamp(tA, topMin(hA), Math.max(0, vpA.h - hA));
          state.h = a.hAnchor;
          state.hOff = a.hDist;
          state.v = a.vAnchor;
          state.vOff = a.vDist;
          settle();
        }
      } catch (err) {}
      refresh(false);
    }).catch(function () {
      refresh(false);
    });
    setInterval(function () {
      refresh(false);
    }, QUOTA_POLL_MS);
    window.addEventListener('whale-refresh', function () {
      refresh(true);
    });
    window.addEventListener('whale-quotas-changed', function () { refresh(false); });
    window.addEventListener('whale-quotas-request', function () {
      if (quotaSnapshot) window.dispatchEvent(new CustomEvent('whale-quotas', { detail: quotaSnapshot }));
    });
    window.addEventListener('whale-open-usage', openQuotaRecords);
    function pollCompletions() {
      return usageClient.pollCompletions({
        codex: function (record) {
          var notice = WhaleTurnNotice.snapshot(record, state.currency);
          if (notice.completionKind === 'success') playTaskEndSound();
          showCostBubble(notice.amount, notice);
          refresh(false);
        },
        claude: function (record) {
          playTaskEndSound();
          showClaudeTurnBubble(record.subscription);
          refresh(false);
        }
      });
    }
    pollCompletions();
    setInterval(pollCompletions, 1000);
    window.addEventListener('whale-approval-request', showApprovalReminder);
    window.addEventListener('whale-pomodoro-reminder', playPomodoroSound);
  }
  if (dshwEnabled) {
    try {
      dshwInit();
    } catch (err) {}
  }
})();
