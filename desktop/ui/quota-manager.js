// 额度管理: every account the pet knows, where its key is kept and how its
// quota is read (账户); what each spent and on what (记录); and when the pet
// says so (提醒). Each change saves at once; the pet picks it up without a reload.
const METHODS = [['auto', '自动识别'], ['billing', '兼容账单接口（常见中转站）'], ['newapi', 'New API / One API 密钥额度'], ['deepseek', 'DeepSeek 账户余额'],
  ['source-usage', '查询链接（日用量与额度）'], ['custom-json', '自定义 JSON 余额接口']];
const KEY_SOURCES = { keychain: '密钥已存入钥匙串', environment: '密钥来自环境变量', 'codex-config': '使用 Codex 配置里的密钥', session: '密钥只保留到挂件退出' };
const KEY_PROBLEMS = { 'keychain-missing': '钥匙串里没有这个账户的密钥', 'keychain-unavailable': '钥匙串暂时不可用', 'key-unavailable': '缺少密钥' };
const PRICE_FIELDS = [['input', '输入'], ['cachedInput', '缓存命中'], ['output', '输出'], ['cacheWrite', '缓存写入']];

export function createQuotaManager({ dialog, request, money, presentation, toast, onChanged }) {
  const body = dialog.querySelector('[data-quota-body]'), error = dialog.querySelector('[data-quota-error]');
  const currency = dialog.querySelector('[data-quota-currency]'), tabs = dialog.querySelector('[data-quota-tabs]');
  let accounts = null, quotas = null, records = null, alertSettings = null, editing = '', adding = false, busy = false, tab = 'accounts';

  // A text given as a function holds amounts: it follows the display currency
  // where it stands, so a new currency or rate never redraws the page.
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (typeof text === 'function') money.bind(node, text);
    else if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (text, className, action) => {
    const node = element('button', className || 'quiet', text);
    node.type = 'button';
    node.addEventListener('click', () => run(action, node));
    return node;
  };
  const field = (label, input, hint) => {
    const wrap = element('label', '', label);
    wrap.append(input);
    if (hint) wrap.append(element('small', '', hint));
    return wrap;
  };
  const input = (name, value = '', { type = 'text', placeholder = '' } = {}) => {
    const node = element('input');
    Object.assign(node, { name, type, value: value ?? '', placeholder, autocomplete: type === 'password' ? 'new-password' : 'off' });
    return node;
  };
  const select = (name, options, value) => {
    const node = element('select');
    node.name = name;
    for (const [option, label] of options) node.append(Object.assign(element('option', '', label), { value: option, selected: option === value }));
    return node;
  };
  const format = money.formatMoney;
  function showError(message) { error.textContent = message || ''; error.hidden = !message; }
  // One action at a time; its own message is the answer when it is refused.
  async function run(action, control) {
    if (busy) return;
    busy = true; showError('');
    if (control) control.disabled = true;
    try { await action(); }
    catch (failure) { showError(failure?.message || '操作未完成，请重试'); }
    finally { busy = false; if (control?.isConnected) control.disabled = false; }
  }
  async function load() {
    [accounts, quotas] = await Promise.all([request('/api/quota-accounts'), request('/api/quotas')]);
    if (tab === 'records') records = await request('/api/quota-records');
    if (tab === 'alerts') alertSettings = (await request('/dsh-whale/usage-settings.json')).settings;
    render();
  }
  async function changed() {
    await load();
    onChanged();
  }

  function quotaLines(view, { today = true } = {}) {
    if (!view) return [];
    const options = { formatMoney: format, now: Date.now(), today };
    const texts = () => {
      const lines = presentation.rows(view, options).map(row => row.label + ' ' + (/%$/.test(row.value) ? '剩余 ' : '') + row.value + (row.note ? ' · ' + row.note : ''));
      const pace = presentation.paceText(view, options), status = presentation.status(view);
      return [...lines, ...(pace ? [pace] : []), ...(status ? [status] : [])];
    };
    return texts().map((_, index) => line(() => texts()[index]));
  }
  function line(text, warn) { return element('p', 'quota-line' + (warn ? ' warn' : ''), text); }
  function quotaOf(id) { return quotas?.accounts.find(account => account.id === id) || null; }

  function subscriptionCard(id, title, details, controls) {
    const card = element('article', 'quota-card'), head = element('div', 'quota-card-head');
    card.dataset.accountId = id;
    head.append(element('strong', '', title));
    card.append(head, ...details);
    if (controls.length) {
      const actions = element('div', 'quota-actions');
      actions.append(...controls);
      card.append(actions);
    }
    return card;
  }
  function renderSubscriptions() {
    const section = element('section', 'quota-section');
    section.append(element('h3', '', '订阅'));
    const codex = quotaOf('codex'), claude = quotaOf('claude'), integration = accounts.claude || {};
    const updated = view => view?.observedAt ? '更新于 ' + presentation.moment(view.observedAt, Date.now()) : '';
    const monitor = Object.assign(element('input'), { type: 'checkbox', checked: accounts.monitorSessions });
    monitor.addEventListener('change', () => run(async () => {
      await request('/api/quota-settings', 'PUT', { monitorSessions: monitor.checked });
      await changed();
    }, monitor));
    const toggle = element('label', 'check');
    toggle.append(monitor, document.createTextNode('读取本机 Codex 会话记录（只读用量与额度，不读对话内容）'));
    const codexLines = codex?.available ? quotaLines(codex) : [line('还没有订阅额度：用 ChatGPT 登录的 Codex 运行一次后出现')];
    section.append(subscriptionCard('codex', codex ? presentation.title(codex) : 'Codex 订阅',
      [...codexLines, line(['来自本机 Codex 会话记录', updated(codex)].filter(Boolean).join(' · '))], [toggle]));
    const claudeLines = claude?.available ? quotaLines(claude) : [];
    // An install from before the task window lacks the hooks that tell what each session is doing.
    const outdated = integration.installed && !integration.tracking;
    const connected = outdated ? '已接入 Claude Code，任务小窗需要更新接入' : integration.installed ? '已接入 Claude Code' : integration.statusLine === 'other' ? 'Claude Code 已有别的状态栏命令，未接入' : '未接入 Claude Code';
    const install = (label, kind, done) => button(label, kind, async () => { await request('/api/claude/integration', 'POST', { action: 'install' }); toast(done); await changed(); });
    const actions = integration.installed ? [button('移除接入', 'quiet', async () => { await request('/api/claude/integration', 'POST', { action: 'uninstall' }); toast('已移除 Claude Code 接入'); await changed(); })] :
      [install('接入 Claude Code', 'primary', '已接入，Claude Code 下次刷新状态栏时开始显示额度')];
    if (outdated) actions.unshift(install('更新接入', 'primary', '已更新，Claude Code 会话下次发消息或回复完成时出现在任务小窗里'));
    section.append(subscriptionCard('claude', 'Claude 订阅', [...claudeLines, line([connected, updated(claude)].filter(Boolean).join(' · '), !integration.installed || outdated)], actions));
    return section;
  }

  function uses(account) {
    const tags = account.codexProviders.map(provider => 'Codex：' + provider);
    if (account.pet) tags.push('大肥鱼');
    return tags;
  }
  function keyLine(account) {
    if (account.keyStatus === 'ready') return line(KEY_SOURCES[account.keyStorage] || '密钥已就绪');
    return line(KEY_PROBLEMS[account.keyStatus] || '缺少密钥', true);
  }
  function keyForm(account) {
    const form = element('form', 'quota-inline'), secret = input('key', '', { type: 'password', placeholder: '粘贴这个账户的 API 密钥' });
    form.append(secret, button('保存密钥', 'primary', async () => {
      if (!secret.value.trim()) throw new Error('请先粘贴密钥');
      await request('/api/quota-accounts/' + account.id, 'PUT', { key: secret.value });
      toast('密钥已保存'); await changed();
    }));
    form.addEventListener('submit', event => event.preventDefault());
    return form;
  }
  function priceRows(prices) {
    const table = element('div', 'quota-prices');
    const add = (model = '', values = {}) => {
      const row = element('div', 'quota-price-row');
      row.append(input('model', model, { placeholder: '模型名称，与 Codex 记录一致' }),
        ...PRICE_FIELDS.map(([key, label]) => Object.assign(input(key, values[key] ?? '', { type: 'number', placeholder: label }), { min: 0, step: 'any', title: label + '（每百万 token）' })),
        Object.assign(button('删除', 'quiet', () => row.remove()), { title: '删除这行价格' }));
      table.append(row);
    };
    for (const [model, values] of Object.entries(prices)) add(model, values);
    const more = button('添加模型价格', 'quiet', () => add());
    return { table, more, read() {
      const result = {};
      for (const row of table.querySelectorAll('.quota-price-row')) {
        const values = Object.fromEntries([...row.querySelectorAll('input')].map(node => [node.name, node.value.trim()]));
        if (!values.model && PRICE_FIELDS.every(([key]) => !values[key])) continue;
        if (!values.model) throw new Error('请填写价格对应的模型名称');
        result[values.model] = Object.fromEntries(PRICE_FIELDS.filter(([key]) => values[key] !== '').map(([key]) => [key, Number(values[key])]));
      }
      return result;
    } };
  }
  function editForm(account) {
    const form = element('form', 'quota-edit');
    const name = input('name', account.name), key = input('key', '', { type: 'password', placeholder: account.keyStatus === 'ready' ? '已保存，留空不变' : '粘贴这个账户的 API 密钥' });
    const unit = select('currency', [['USD', '美元 USD'], ['CNY', '人民币 CNY']].concat(['USD', 'CNY'].includes(account.currency) ? [] : [[account.currency, account.currency]]), account.currency);
    const safe = Object.assign(input('safeAmount', account.safeAmount ?? '', { type: 'number', placeholder: '留空：按满格余额或额度上限' }), { min: 0, step: 'any' });
    const prices = priceRows(account.prices);
    const grid = element('div', 'field-grid');
    grid.append(field('名称', name), field('密钥', key, '只存入 macOS 钥匙串，不写进设置文件'), field('币种', unit, '余额接口没有说明币种时，按这个币种记账'),
      field('安全额度', safe, '余额或剩余额度不低于这个金额就算满格（100%），按账户的币种'));
    const advanced = element('details');
    advanced.append(element('summary', '', '高级：查询方式与 Codex 归属'));
    const method = select('method', METHODS, account.balance.method), queryUrl = input('queryUrl', account.balance.queryUrl, { placeholder: account.endpoint.replace(/\/+$/, '') + '/usage' });
    const balancePath = input('balancePath', account.balance.balancePath, { placeholder: '/api/user/balance' }), balanceField = input('balanceField', account.balance.balanceField);
    const usedField = input('usedField', account.balance.usedField), balanceScale = input('balanceScale', account.balance.balanceScale, { type: 'number' });
    const divisor = input('billingUsageDivisor', account.balance.billingUsageDivisor, { type: 'number' }), perUnit = input('quotaPerUnit', account.balance.quotaPerUnit, { type: 'number' });
    const providers = input('codexProviders', account.codexProviders.join(', '), { placeholder: '例如 OpenAI' });
    const dashboard = input('dashboardUrl', account.dashboardUrl, { type: 'url', placeholder: '账单页面，可留空' });
    const advancedGrid = element('div', 'field-grid');
    advancedGrid.append(field('查询方式', method), field('查询链接', queryUrl, '与 API 地址同域；返回 daily_usage 与 rate_limits'),
      field('余额路径', balancePath, '自定义 JSON 接口使用'), field('金额字段', balanceField), field('已用字段', usedField), field('余额系数', balanceScale),
      field('账单用量换算', divisor), field('额度单位换算', perUnit), field('Codex 的 provider 名称', providers, '会话日志里这些 provider 的任务算作这个账户'), field('账单页面', dashboard));
    advanced.append(advancedGrid);
    const actions = element('div', 'quota-actions');
    actions.append(button('保存', 'primary', async () => {
      const patch = { name: name.value, currency: unit.value, prices: prices.read(), dashboardUrl: dashboard.value.trim(), safeAmount: safe.value.trim() === '' ? null : safe.value.trim(),
        codexProviders: providers.value.split(/[,，\s]+/).map(item => item.trim()).filter(Boolean),
        balance: { method: method.value, queryUrl: queryUrl.value.trim(), balancePath: balancePath.value.trim(), balanceField: balanceField.value.trim(),
          usedField: usedField.value.trim(), balanceScale: balanceScale.value, billingUsageDivisor: divisor.value, quotaPerUnit: perUnit.value } };
      if (key.value.trim()) patch.key = key.value;
      await request('/api/quota-accounts/' + account.id, 'PUT', patch);
      editing = ''; toast('已保存'); await changed();
    }), button('取消', 'quiet', () => { editing = ''; render(); }));
    form.append(grid, element('p', 'quota-subhead', '每百万 token 价格（用于估算 Codex 每轮花费）'), prices.table, prices.more, advanced, actions);
    form.addEventListener('submit', event => event.preventDefault());
    return form;
  }
  function apiCard(account) {
    const card = element('article', 'quota-card'), head = element('div', 'quota-card-head'), view = quotaOf(account.id);
    card.dataset.accountId = account.id;
    head.append(element('strong', '', account.name), element('span', 'quota-host', account.host), ...uses(account).map(tag => element('span', 'quota-tag', tag)));
    card.append(head, ...quotaLines(view?.available || view?.error ? view : null), keyLine(account));
    if (account.keyStatus !== 'ready' && editing !== account.id) card.append(keyForm(account));
    if (editing === account.id) card.append(editForm(account));
    else {
      const actions = element('div', 'quota-actions');
      actions.append(button('立即查询', 'quiet', async () => {
        const result = await request('/api/quota-accounts/' + account.id + '/query', 'POST');
        toast(result.quota?.error ? '查询失败：' + result.quota.error : '已更新'); await changed();
      }), button('编辑', 'quiet', () => { editing = account.id; adding = false; render(); }),
      button('隐藏', 'quiet', async () => { await request('/api/quota-accounts/' + account.id, 'PUT', { hidden: true }); await changed(); }));
      card.append(actions);
    }
    return card;
  }
  function addForm() {
    const form = element('form', 'quota-card quota-add'), name = input('name', '', { placeholder: '例如 Kimi、公司中转站' });
    const endpoint = input('endpoint', '', { type: 'url', placeholder: 'https://api.example.com/v1' }), key = input('key', '', { type: 'password', placeholder: '粘贴 API 密钥' });
    const grid = element('div', 'field-grid');
    grid.append(field('名称', name), field('API 地址', endpoint), field('密钥', key, '只存入 macOS 钥匙串'));
    const actions = element('div', 'quota-actions');
    actions.append(button('保存并查询', 'primary', async () => {
      const result = await request('/api/quota-accounts', 'POST', { name: name.value, endpoint: endpoint.value.trim(), key: key.value });
      adding = false;
      toast(result.quota?.error ? '已保存；查询失败：' + result.quota.error : '已保存，额度已更新');
      await changed();
    }), button('取消', 'quiet', () => { adding = false; render(); }));
    form.append(element('strong', '', '添加 API 账户'), grid, actions);
    form.addEventListener('submit', event => event.preventDefault());
    return form;
  }
  function renderAccounts() {
    const section = element('section', 'quota-section'), visible = accounts.accounts.filter(account => !account.hidden), hidden = accounts.accounts.filter(account => account.hidden);
    section.append(element('h3', '', 'API 账户'));
    if (!visible.length) section.append(line('还没有 API 账户。Codex 配置里的 provider 会自动出现；也可以手动添加。'));
    section.append(...visible.map(apiCard));
    section.append(adding ? addForm() : button('添加 API 账户', 'quiet quota-add-button', () => { adding = true; editing = ''; render(); }));
    if (hidden.length) {
      const folded = element('details', 'quota-hidden');
      folded.append(element('summary', '', '已隐藏的账户（' + hidden.length + '）'));
      for (const account of hidden) {
        const row = element('div', 'quota-hidden-row');
        row.append(element('span', '', account.name + ' · ' + account.host),
          button('显示', 'quiet', async () => { await request('/api/quota-accounts/' + account.id, 'PUT', { hidden: false }); await changed(); }));
        folded.append(row);
      }
      section.append(folded);
    }
    return section;
  }
  const pad = value => String(value).padStart(2, '0');
  const dayOf = date => new Date(date + 'T00:00:00');
  const stamp = at => { const time = new Date(at); return (time.getMonth() + 1) + '/' + time.getDate() + ' ' + pad(time.getHours()) + ':' + pad(time.getMinutes()); };
  const todayKey = () => { const now = new Date(); return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()); };
  const weekday = date => date === todayKey() ? '今天' : '周' + '日一二三四五六'.charAt(dayOf(date).getDay());
  const STATES = { estimated: '（估算）', observed: '（期间扣费）' };
  const OUTCOMES = { failed: '失败', aborted: '已取消', interrupted: '中断', superseded: '被打断', cancelled: '已取消' };

  // The last seven days as bars, today last; on an account Codex and the pet
  // share, the pet's part is drawn inside each bar.
  function chart(days, unit, split) {
    const max = Math.max(0, ...days.map(day => day.total || 0)), box = element('div', 'quota-chart');
    box.setAttribute('role', 'img');
    money.bind(box, () => '近 7 天每日消费：' + days.map(day => day.date.slice(5) + ' ' + (day.total === null ? '没有记录' : format(day.total, unit))).join('，'),
      label => box.setAttribute('aria-label', label));
    for (const day of days) {
      const column = element('div', 'quota-chart-day'), track = element('div', 'quota-chart-track');
      money.bind(column, () => day.date.slice(5).replace('-', '/') + ' ' + (day.total === null ? '没有记录' : format(day.total, unit) + (day.estimated ? '（估算）' : '')) +
        (split && Number.isFinite(day.pet) ? '，其中大肥鱼 ' + format(day.pet, unit) : ''), title => { column.title = title; });
      if (day.total !== null && max > 0) {
        const bar = element('div', 'quota-chart-bar' + (day.estimated ? ' estimated' : ''));
        bar.style.height = Math.max(2, day.total / max * 100) + '%';
        if (split && Number.isFinite(day.pet) && day.total > 0) {
          const pet = element('div', 'quota-chart-pet');
          pet.style.height = Math.min(100, day.pet / day.total * 100) + '%';
          bar.append(pet);
        }
        track.append(bar);
      } else track.classList.add(day.total === null ? 'unknown' : 'empty');
      column.append(track, element('span', 'quota-chart-label', weekday(day.date)));
      box.append(column);
    }
    return box;
  }
  function eventRow(time, source, model, amount, tokens) {
    const row = element('div', 'quota-event');
    row.append(element('span', 'quota-event-time', time), element('span', 'quota-event-source', source), element('span', 'quota-event-model', model),
      element('span', 'quota-event-amount', amount), element('span', 'quota-event-tokens', Number.isFinite(tokens) ? tokens.toLocaleString('en-US') + ' tokens' : ''));
    return row;
  }
  function eventDetails(events) {
    const details = element('details', 'quota-events');
    details.append(element('summary', '', '明细（最近 ' + events.length + ' 条）'));
    for (const event of events) {
      const amount = () => Number.isFinite(event.amount) ? format(event.amount, event.currency) + (STATES[event.state] || '') : event.state === 'pending' ? '待记账' : '金额未知';
      details.append(eventRow(stamp(event.at), event.kind === 'pet' ? '大肥鱼' : 'Codex', event.model + (OUTCOMES[event.outcome] ? ' · ' + OUTCOMES[event.outcome] : ''), amount, event.tokens));
    }
    return details;
  }
  function turnDetails(turns) {
    const details = element('details', 'quota-events');
    details.append(element('summary', '', '最近几轮（' + turns.length + '）'));
    for (const turn of turns) {
      const left = [['5h', turn.fiveHour], ['7d', turn.sevenDay]].filter(([, value]) => Number.isFinite(value)).map(([label, value]) => label + ' 剩 ' + Math.round(value) + '%').join(' · ');
      details.append(eventRow(stamp(turn.at), 'Codex', turn.model + (OUTCOMES[turn.outcome] ? ' · ' + OUTCOMES[turn.outcome] : ''), left || '--', turn.tokens));
    }
    return details;
  }
  function spendBlocks(record) {
    const unit = record.currency, amount = value => format(value, unit);
    const blocks = [chart(record.days.slice(0, 7).reverse(), unit, record.split),
      line(() => '今日 ' + amount(record.today) + ' · 近 7 天 ' + amount(record.days7) + ' · 近 30 天 ' + amount(record.days30))];
    if (record.split) {
      const week = key => record.days.slice(0, 7).reduce((total, day) => total + (Number.isFinite(day[key]) ? day[key] : 0), 0);
      blocks.push(line(() => '近 7 天：Codex 任务 ' + amount(week('codex')) + ' · 大肥鱼 ' + amount(week('pet'))));
    }
    if (record.days.some(day => day.estimated)) blocks.push(line('没有账单记录的日子按大肥鱼的请求估算'));
    if (record.events.length) blocks.push(eventDetails(record.events));
    return blocks;
  }
  function renderRecords() {
    const section = element('section', 'quota-section'), byId = new Map((records?.accounts || []).map(item => [item.id, item]));
    const views = presentation.overview(quotas);
    if (!views.length) section.append(line('还没有可以显示的额度。'));
    for (const view of views) {
      const record = byId.get(view.id) || {}, card = element('article', 'quota-card'), head = element('div', 'quota-card-head');
      card.dataset.accountId = view.id;
      head.append(element('strong', '', presentation.title(view)));
      if (view.id === quotas.current) head.append(element('span', 'quota-tag', '当前'));
      card.append(head, ...quotaLines(view.available || view.error ? view : null, { today: !record.days }));
      if (record.days) card.append(...spendBlocks(record));
      if (record.turns?.length) card.append(turnDetails(record.turns));
      section.append(card);
    }
    return section;
  }

  // How completions show is kept by the widget; ask it, then tell it.
  function noticeState() {
    let state = { turnCostOn: true, turnCostCloseMs: 5000, failed: true, cancelled: true };
    const listen = event => { state = { ...state, ...event.detail }; };
    window.addEventListener('whale-notice-settings-state', listen);
    window.dispatchEvent(new Event('whale-notice-settings-request'));
    window.removeEventListener('whale-notice-settings-state', listen);
    return state;
  }
  function renderAlerts() {
    const settings = alertSettings.quotaAlerts, notice = noticeState(), form = element('form', 'quota-alerts');
    const units = [...new Set(['USD', 'CNY', ...accounts.accounts.map(account => account.currency)])];
    const symbol = unit => unit === 'CNY' ? '¥' : unit === 'USD' ? '$' : unit;
    const check = (name, checked, label) => {
      const wrap = element('label', 'check');
      wrap.append(Object.assign(element('input'), { type: 'checkbox', name, checked }), document.createTextNode(label));
      return wrap;
    };
    const number = (name, value, extra = {}) => Object.assign(input(name, value ?? '', { type: 'number' }), { min: 0, step: 'any', ...extra });
    const amounts = (prefix, values) => {
      const row = element('div', 'quota-amounts');
      for (const unit of units) {
        const wrap = element('label', 'quota-amount', symbol(unit));
        wrap.append(number(prefix + ':' + unit, values[unit] ?? '', { placeholder: '不提醒' }));
        row.append(wrap);
      }
      return row;
    };
    const low = element('fieldset', 'quota-fieldset'), budget = element('fieldset', 'quota-fieldset'), done = element('fieldset', 'quota-fieldset');
    const percents = element('div', 'field-grid');
    percents.append(field('订阅和带上限的额度：剩余低于（%）', number('windowPercent', settings.windowPercent, { max: 100 })),
      field('余额：低于满格的（%）', number('balancePercent', settings.balancePercent, { max: 100 }), '满格是上次充值以来的最高余额'));
    low.append(element('legend', '', '额度不足提醒'), check('on', settings.on, '额度或余额快用完时提醒'), percents,
      element('p', 'quota-subhead', '余额低于这个金额时也提醒'), amounts('below', settings.balanceBelow));
    budget.append(element('legend', '', '今日消费提醒'), check('budgetOn', settings.budgetOn, '今天的消费超过下面的金额时提醒（同一币种的账户合计）'), amounts('budget', settings.dailyBudget));
    done.append(element('legend', '', '完成提示'), check('turnCostOn', notice.turnCostOn, 'Codex 每轮结束时显示这一轮的花费'),
      field('气泡停留（秒，0 表示点一下才关）', number('turnCostSeconds', Math.round(notice.turnCostCloseMs / 1000), { step: 1 })),
      check('failed', notice.failed, '任务失败时也提示'), check('cancelled', notice.cancelled, '任务暂停或取消时也提示'));
    const actions = element('div', 'quota-actions');
    actions.append(button('保存', 'primary', async () => {
      const value = name => form.elements.namedItem(name);
      const read = prefix => Object.fromEntries(units.map(unit => [unit, value(prefix + ':' + unit).value.trim()]).filter(([, amount]) => amount !== ''));
      const outcomeNotice = { failed: value('failed').checked, cancelled: value('cancelled').checked };
      const saved = await request('/dsh-whale/usage-settings.json', 'PUT', { outcomeNotice, quotaAlerts: { on: value('on').checked, windowPercent: value('windowPercent').value,
        balancePercent: value('balancePercent').value, balanceBelow: read('below'), budgetOn: value('budgetOn').checked, dailyBudget: read('budget') } });
      alertSettings = saved.settings;
      window.dispatchEvent(new CustomEvent('whale-notice-settings', { detail: { ...outcomeNotice, turnCostOn: value('turnCostOn').checked,
        turnCostCloseMs: Math.max(0, Math.round(Number(value('turnCostSeconds').value) || 0)) * 1000 } }));
      toast('提醒设置已保存'); onChanged();
    }));
    form.append(low, budget, done, actions);
    form.addEventListener('submit', event => event.preventDefault());
    return form;
  }
  function render() {
    if (!accounts) return;
    for (const node of tabs.querySelectorAll('[data-tab]')) node.setAttribute('aria-selected', String(node.dataset.tab === tab));
    const scroll = body.scrollTop;
    body.replaceChildren(...(tab === 'records' && records ? [renderRecords()] : tab === 'alerts' && alertSettings ? [renderAlerts()] : tab === 'accounts' ? [renderSubscriptions(), renderAccounts()] : []));
    if (accounts.error) showError(accounts.error);
    body.scrollTop = scroll;
  }
  for (const node of tabs.querySelectorAll('[data-tab]')) node.addEventListener('click', () => {
    if (tab === node.dataset.tab) return;
    tab = node.dataset.tab; editing = ''; adding = false; showError('');
    body.scrollTop = 0;
    render();
    void run(load);
  });

  currency.addEventListener('change', () => run(async () => {
    if (!await money.setDisplayCurrency(currency.value || null)) toast('还没有汇率，金额先按各自的币种显示，拿到汇率后自动换算');
  }, currency));
  // A new currency or rate rewrites the amounts where they stand and redraws
  // nothing, so a form being filled in keeps what was typed.
  let written = '';
  money.onChange(state => {
    currency.value = state.displayCurrency || '';
    const next = (state.displayCurrency || '') + ' ' + (state.quote?.usdCny ?? '');
    if (next !== written) { written = next; money.refreshBindings(body); }
  });
  dialog.querySelector('[data-quota-close]').addEventListener('click', () => dialog.close());
  return Object.freeze({
    async open({ tab: page = 'accounts' } = {}) {
      editing = ''; adding = false; showError('');
      tab = ['accounts', 'records', 'alerts'].includes(page) ? page : 'accounts';
      render();
      if (!dialog.open) dialog.showModal();
      try { await load(); } catch (failure) { showError(failure?.message || '额度暂时无法读取'); }
    },
  });
}
