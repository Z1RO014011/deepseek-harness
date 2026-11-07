import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { CoachStore } from './store.js'

export const name = 'dsh-lol-coach'
export const inject = ['tools', 'systemPrompt']

const coachInstructions = `你是英雄联盟五人组排 BP 教练。你只能依据当前对局、当局五人档案和已加载的版本证据给建议。

BP 工作规则：
- 每次给建议前先调用 lol_coach_get_bp_context，使用最新 stateRevision；截图或选禁发生变化时先记录观察再重新读取。
- 只把 certainty=confirmed 的 pick/ban 当成确定的已选或已禁；hover 是意向，不代表锁定。未知和不确定信息要明确说明。
- 默认候选必须来自目标队员的当前英雄池，遵守已禁和已选过滤。候选工具没有返回可用英雄时，先请用户补全档案或明确允许讨论池外英雄。
- 输出一个优先方案和最多两个备选，说明熟练度、阵容取舍、风险和后续接续；不能把解释性判断说成真实胜率。
- 给出具体英雄建议后，调用 lol_coach_save_recommendation 保存优先选择和备选，并使用刚读取的 stateRevision；若资料约束导致无法归档，要明确告诉用户。
- patchKnowledge.evidenceLoaded 为 false 时，只能复述用户提供的版本标签，不得声称某英雄是当前版本强势或编造胜率。
- 保持中文简洁。若用户给了截图，说明这是截图观察；未连接自动窗口采集前，不要声称正在实时监控游戏。` 

function databasePath() {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const dataDirectory = process.env.LOL_COACH_DATA_DIR || join(dshHome, 'data')
  return join(dataDirectory, 'lol-coach.sqlite')
}

function registerTextTool(ctx, { toolName, description, parameters = {}, execute }) {
  ctx.tools.register(defineTool({
    name: toolName,
    description,
    parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const value = await execute(args)
      return JSON.stringify(value, null, 2)
    },
  }))
}

export function apply(ctx) {
  const store = new CoachStore(databasePath())
  ctx.effect(() => () => store.close())
  ctx.systemPrompt.section({
    name: 'deployment:lol-coach',
    order: 400,
    text: coachInstructions,
  })

  registerTextTool(ctx, {
    toolName: 'lol_coach_save_player_profile',
    description: 'Create or update one teammate and their confirmed champion pool. heroesJson is an array of objects with championId, position, proficiency (1-5), and preference (main, available, or avoid). Use source=confirmed_voice only when the speaker identity was confirmed.',
    parameters: {
      playerId: { type: 'string', required: true, description: 'Stable team member ID; do not use a changeable nickname as the ID.' },
      displayName: { type: 'string', required: true, description: 'Name shown to the team.' },
      heroesJson: { type: 'string', required: true, description: 'JSON array, for example [{"championId":"Ahri","position":"mid","proficiency":4,"preference":"main"}]. Use canonical champion IDs.' },
      source: { type: 'string', description: 'manual (default), confirmed_voice, or import.' },
    },
    execute: args => store.savePlayerProfile(args),
  })

  registerTextTool(ctx, {
    toolName: 'lol_coach_list_roster',
    description: 'List the saved teammates and their current champion pools.',
    execute: () => store.listRoster(),
  })

  registerTextTool(ctx, {
    toolName: 'lol_coach_start_bp',
    description: 'Start a BP record for exactly five saved teammates. playersJson is an array of {playerId, position}; queueType and patchVersion are user-confirmed labels.',
    parameters: {
      queueType: { type: 'string', required: true, description: 'Queue name confirmed by the user; never assume a professional draft format.' },
      patchVersion: { type: 'string', required: true, description: 'Current CN server patch label confirmed by the user.' },
      playersJson: { type: 'string', required: true, description: 'JSON array of exactly five {playerId, position} objects. Positions: top, jungle, mid, bottom, support, flex, unknown.' },
    },
    execute: args => store.startMatch(args),
  })

  registerTextTool(ctx, {
    toolName: 'lol_coach_record_bp_observation',
    description: 'Persist one visible BP observation from a screenshot, manual correction, or available client event. Use unknown when the champion cannot be identified. sourceEventId makes a replayed event idempotent.',
    parameters: {
      matchId: { type: 'string', required: true, description: 'BP match ID returned by lol_coach_start_bp.' },
      eventType: { type: 'string', required: true, description: 'pick, ban, hover, or unknown.' },
      side: { type: 'string', required: true, description: 'ally or enemy.' },
      championId: { type: 'string', description: 'Canonical champion ID; omit when eventType is unknown.' },
      playerId: { type: 'string', description: 'Known allied player ID, if visible.' },
      position: { type: 'string', description: 'Known position, or omit when unknown.' },
      certainty: { type: 'string', description: 'confirmed, uncertain, or low; defaults to confirmed for pick/ban and uncertain for hover/unknown.' },
      source: { type: 'string', description: 'screenshot, manual, client, or import.' },
      sourceEventId: { type: 'string', description: 'Optional stable ID from the source event or replay.' },
      observedAt: { type: 'string', description: 'Optional ISO timestamp for the observation.' },
    },
    execute: args => store.recordObservation(args),
  })

  registerTextTool(ctx, {
    toolName: 'lol_coach_get_bp_context',
    description: 'Get the current BP state, event history, confirmed unavailable champions, latest recommendations, and eligible candidates for one teammate.',
    parameters: {
      matchId: { type: 'string', required: true, description: 'BP match ID.' },
      playerId: { type: 'string', description: 'Teammate for whom candidates are requested.' },
      position: { type: 'string', description: 'Optional target position; defaults to that teammate’s assigned position.' },
    },
    execute: args => store.getMatchContext(args.matchId, args),
  })

  registerTextTool(ctx, {
    toolName: 'lol_coach_save_recommendation',
    description: 'Save the one priority champion and up to two alternatives offered for the current BP revision. All candidates must be in that teammate’s saved pool and available.',
    parameters: {
      matchId: { type: 'string', required: true, description: 'BP match ID.' },
      playerId: { type: 'string', required: true, description: 'Teammate receiving the recommendation.' },
      position: { type: 'string', description: 'Optional target position.' },
      basedOnRevision: { type: 'integer', required: true, description: 'stateRevision from the context used to make this recommendation.' },
      candidatesJson: { type: 'string', required: true, description: 'JSON array of one to three canonical champion IDs, in priority order.' },
      rationale: { type: 'string', required: true, description: 'Short Chinese summary of reasons and tradeoffs.' },
    },
    execute: args => store.saveRecommendation(args),
  })

  registerTextTool(ctx, {
    toolName: 'lol_coach_finish_bp',
    description: 'Mark a BP record completed, cancelled, or incomplete and save optional notes.',
    parameters: {
      matchId: { type: 'string', required: true, description: 'BP match ID.' },
      status: { type: 'string', required: true, description: 'completed, cancelled, or incomplete.' },
      notes: { type: 'string', description: 'Optional user-provided summary or result.' },
    },
    execute: args => store.finishMatch(args),
  })

  console.info(`[${name}] loaded; database: ${databasePath()}`)
}
