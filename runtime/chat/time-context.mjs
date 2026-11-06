const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const two = value => String(value).padStart(2, '0');
const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

// How the model reads the time tags. It holds no clock, so requests made at
// different times share it and the provider can keep caching what follows.
export function timeNote() {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || '本地时区';
  return `用户消息开头方括号里的时间由系统标注，是这条消息发出时用户设备的本地时间（时区 ${zone}），不是用户输入的内容，回复中不要写这种标注。最后一条消息的时间就是现在；更早的消息可能来自几小时或几天前，按标注的时间理解之前聊过的事，不要当成刚刚发生。可以结合时间、角色人设和聊天上下文自然调整话题与建议，不必每次报时；仅凭时间不能推断用户正在做什么。`;
}

const elapsed = ms => ms < HOUR ? Math.round(ms / MINUTE) + ' 分钟' : ms < 2 * DAY ? Math.round(ms / HOUR) + ' 小时' : Math.round(ms / DAY) + ' 天';

// The tag that starts a user message, such as "[2026-10-01 星期四 15:02] ".
// From half an hour after `previous` on, it also says how long has passed; an
// unknown time gets no tag.
export function timeTag(timestamp, previous) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const gap = date - new Date(previous);
  const since = gap >= 30 * MINUTE ? '，距上一条消息约 ' + elapsed(gap) : '';
  return `[${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${WEEKDAYS[date.getDay()]} ${two(date.getHours())}:${two(date.getMinutes())}${since}] `;
}
