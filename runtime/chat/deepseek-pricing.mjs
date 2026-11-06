export const PRICE_VERSION = 'deepseek-flash-2026-09-27';
const FLASH_MODELS = new Set(['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']);
const RATES = { CNY: { hit: 0.04, miss: 2, output: 8 }, USD: { hit: 0.006, miss: 0.3, output: 1.2 } };
const HOLIDAYS_2026 = [['01-01', '01-03'], ['02-15', '02-23'], ['04-04', '04-06'], ['05-01', '05-05'], ['06-19', '06-21'], ['09-25', '09-27'], ['10-01', '10-07']];
const tokenCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

export function officialDeepSeek(baseUrl) {
  try { return new URL(baseUrl).origin === 'https://api.deepseek.com'; } catch { return false; }
}

export function billingUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const prompt = tokenCount(value.prompt_tokens), output = tokenCount(value.completion_tokens);
  if (prompt === null || output === null) return null;
  let hit = tokenCount(value.prompt_cache_hit_tokens ?? value.prompt_tokens_details?.cached_tokens);
  let miss = tokenCount(value.prompt_cache_miss_tokens);
  if (hit === null && miss !== null) hit = prompt - miss;
  if (miss === null && hit !== null) miss = prompt - hit;
  if (hit !== null && (hit < 0 || miss < 0 || hit + miss !== prompt)) return null;
  return { prompt_tokens: prompt, completion_tokens: output, total_tokens: prompt + output,
    ...(hit === null ? {} : { prompt_cache_hit_tokens: hit, prompt_cache_miss_tokens: miss }) };
}

function pricePeriod(timestamp) {
  const local = new Date(timestamp + 8 * 60 * 60 * 1000);
  const weekday = local.getUTCDay(), hour = local.getUTCHours();
  if (weekday === 0 || weekday === 6 || !(hour >= 9 && hour < 12 || hour >= 14 && hour < 18)) return 'off-peak';
  if (local.getUTCFullYear() !== 2026) return 'uncertain';
  const day = local.toISOString().slice(5, 10);
  return HOLIDAYS_2026.some(([start, end]) => day >= start && day <= end) ? 'off-peak' : 'peak';
}

export function estimateDeepSeek(model, usage, timestamp) {
  if (!FLASH_MODELS.has(model) || !Number.isFinite(timestamp) || timestamp < Date.parse('2026-09-10T04:00:00Z')) return null;
  const tokens = billingUsage(usage);
  if (!tokens) return null;
  const period = pricePeriod(timestamp), cached = tokens.prompt_cache_hit_tokens;
  const cacheKnown = cached !== undefined;
  const minFactor = period === 'peak' ? 1 : 0.5, maxFactor = period === 'off-peak' ? 0.5 : 1;
  const amounts = Object.fromEntries(Object.entries(RATES).map(([currency, rates]) => {
    const inputMin = cacheKnown ? cached * rates.hit + tokens.prompt_cache_miss_tokens * rates.miss : tokens.prompt_tokens * rates.hit;
    const inputMax = cacheKnown ? inputMin : tokens.prompt_tokens * rates.miss;
    return [currency, { min: (inputMin + tokens.completion_tokens * rates.output) * minFactor / 1e6,
      max: (inputMax + tokens.completion_tokens * rates.output) * maxFactor / 1e6 }];
  }));
  return { priceVersion: PRICE_VERSION, period, amounts };
}
