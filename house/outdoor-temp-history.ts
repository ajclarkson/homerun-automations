import { defineAutomation, abort } from '@ajclarkson/homerun';

const HISTORY_ENTITY = 'input_text.outdoor_temp_7day_history';
const MAX_ENTRIES = 7;

interface TempHistory {
  date: string;
  temps: number[];
}

function parseHistory(raw: string | undefined): TempHistory {
  try {
    const parsed = JSON.parse(raw ?? '{}');
    return {
      date: typeof parsed.date === 'string' ? parsed.date : '',
      temps: Array.isArray(parsed.temps) ? parsed.temps : [],
    };
  } catch {
    return { date: '', temps: [] };
  }
}

export default defineAutomation({
  id: 'house:outdoor_temp_history',
  location: 'house',
  subsystem: 'thermal',

  triggers: [
    { type: 'schedule', cron: '0 23 * * *' },
  ],

  context: (state) => {
    const forecast = state('weather.forecast_home');
    const todayHigh = forecast?.attributes?.['temperature'] as number | undefined;

    if (todayHigh === undefined || !Number.isFinite(todayHigh)) {
      return abort('forecast_temperature_unavailable');
    }

    const today = new Date().toISOString().slice(0, 10);
    const historyRaw = state(HISTORY_ENTITY)?.state;
    const history = parseHistory(historyRaw);

    return {
      today,
      todayHigh,
      history,
    };
  },

  reduce: (ctx) => {
    const { today, todayHigh, history } = ctx;

    if (history.date === today) {
      return { decision: 'no_action', reason: 'already_recorded_today', actions: [] };
    }

    const temps = [...history.temps, todayHigh];
    if (temps.length > MAX_ENTRIES) temps.shift();

    const updated: TempHistory = { date: today, temps };

    return {
      decision: 'record',
      reason: 'end_of_day',
      actions: [
        {
          type: 'ha.call_service',
          domain: 'input_text',
          service: 'set_value',
          target: { entity_id: HISTORY_ENTITY },
          data: { value: JSON.stringify(updated) },
        },
      ],
    };
  },
});
