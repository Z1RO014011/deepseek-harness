import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const POSITIONS = new Set(['top', 'jungle', 'mid', 'bottom', 'support', 'flex', 'unknown'])
const PREFERENCES = new Set(['main', 'available', 'avoid'])
const OBSERVATION_TYPES = new Set(['pick', 'ban', 'hover', 'unknown'])
const OBSERVATION_SIDES = new Set(['ally', 'enemy'])
const CERTAINTIES = new Set(['confirmed', 'uncertain', 'low'])
const SOURCES = new Set(['screenshot', 'manual', 'client', 'import'])
const PROFILE_SOURCES = new Set(['manual', 'confirmed_voice', 'import'])
const MATCH_STATUSES = new Set(['completed', 'cancelled', 'incomplete'])

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`)
  }
  return value.trim()
}

function parseJson(value, label) {
  try {
    return JSON.parse(requiredString(value, label))
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} must contain valid JSON.`)
    throw error
  }
}

function assertPosition(position, label = 'position') {
  const value = requiredString(position, label).toLowerCase()
  if (!POSITIONS.has(value)) {
    throw new Error(`${label} must be one of: ${[...POSITIONS].join(', ')}.`)
  }
  return value
}

function decodeJson(value, fallback = null) {
  if (value == null) return fallback
  return JSON.parse(value)
}

function isoNow() {
  return new Date().toISOString()
}

function toPublicEvent(row) {
  return {
    eventId: row.event_id,
    sequence: row.sequence_no,
    type: row.event_type,
    side: row.side,
    championId: row.champion_id,
    playerId: row.player_id,
    position: row.position,
    certainty: row.certainty,
    source: row.source,
    observedAt: row.observed_at,
    stateRevision: row.state_revision,
  }
}

export class CoachStore {
  constructor(databasePath) {
    mkdirSync(dirname(databasePath), { recursive: true })
    this.db = new DatabaseSync(databasePath)
    this.closed = false
    try {
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;')
      this.migrate()
    } catch (error) {
      this.db.close()
      this.closed = true
      throw error
    }
  }

  migrate() {
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get()
    if (version > 1) throw new Error(`Database schema ${version} is newer than this plugin supports.`)
    if (version === 1) return

    this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE players (
        player_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE player_hero_pool (
        player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
        champion_id TEXT NOT NULL,
        position TEXT NOT NULL,
        proficiency INTEGER NOT NULL CHECK (proficiency BETWEEN 1 AND 5),
        preference TEXT NOT NULL CHECK (preference IN ('main', 'available', 'avoid')),
        source TEXT NOT NULL CHECK (source IN ('manual', 'confirmed_voice', 'import')),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (player_id, champion_id, position)
      );
      CREATE TABLE matches (
        match_id TEXT PRIMARY KEY,
        queue_type TEXT NOT NULL,
        patch_version TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'cancelled', 'incomplete')),
        state_revision INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        notes TEXT
      );
      CREATE TABLE match_players (
        match_id TEXT NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,
        player_id TEXT NOT NULL REFERENCES players(player_id),
        position TEXT NOT NULL,
        profile_snapshot_json TEXT NOT NULL,
        PRIMARY KEY (match_id, player_id)
      );
      CREATE TABLE bp_events (
        event_id TEXT PRIMARY KEY,
        match_id TEXT NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,
        sequence_no INTEGER NOT NULL,
        source_event_id TEXT,
        event_type TEXT NOT NULL CHECK (event_type IN ('pick', 'ban', 'hover', 'unknown')),
        side TEXT NOT NULL CHECK (side IN ('ally', 'enemy')),
        champion_id TEXT,
        player_id TEXT REFERENCES players(player_id),
        position TEXT,
        certainty TEXT NOT NULL CHECK (certainty IN ('confirmed', 'uncertain', 'low')),
        source TEXT NOT NULL CHECK (source IN ('screenshot', 'manual', 'client', 'import')),
        observed_at TEXT NOT NULL,
        state_revision INTEGER NOT NULL,
        UNIQUE (match_id, sequence_no),
        UNIQUE (match_id, source_event_id)
      );
      CREATE TABLE recommendations (
        recommendation_id TEXT PRIMARY KEY,
        match_id TEXT NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,
        player_id TEXT NOT NULL REFERENCES players(player_id),
        position TEXT NOT NULL,
        based_on_revision INTEGER NOT NULL,
        candidates_json TEXT NOT NULL,
        rationale TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('current', 'stale', 'superseded')),
        created_at TEXT NOT NULL
      );
      CREATE INDEX bp_events_match_sequence ON bp_events(match_id, sequence_no);
      CREATE INDEX recommendations_match_created ON recommendations(match_id, created_at);
      PRAGMA user_version = 1;
      COMMIT;
    `)
  }

  assertOpen() {
    if (this.closed) throw new Error('The coach database is closed.')
  }

  transaction(run) {
    this.assertOpen()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = run()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getPlayerProfile(playerId) {
    const id = requiredString(playerId, 'playerId')
    const player = this.db.prepare(`
      SELECT player_id, display_name, created_at, updated_at
      FROM players WHERE player_id = ?
    `).get(id)
    if (!player) throw new Error(`Unknown playerId: ${id}. Save the player profile first.`)
    const heroes = this.db.prepare(`
      SELECT champion_id, position, proficiency, preference, source, updated_at
      FROM player_hero_pool WHERE player_id = ?
      ORDER BY preference = 'main' DESC, proficiency DESC, champion_id
    `).all(id).map(row => ({
      championId: row.champion_id,
      position: row.position,
      proficiency: row.proficiency,
      preference: row.preference,
      source: row.source,
      updatedAt: row.updated_at,
    }))
    return {
      playerId: player.player_id,
      displayName: player.display_name,
      createdAt: player.created_at,
      updatedAt: player.updated_at,
      heroes,
    }
  }

  savePlayerProfile({ playerId, displayName, heroesJson, source = 'manual' }) {
    this.assertOpen()
    const id = requiredString(playerId, 'playerId')
    const name = requiredString(displayName, 'displayName')
    const profileSource = requiredString(source, 'source').toLowerCase()
    if (!PROFILE_SOURCES.has(profileSource)) {
      throw new Error('source must be manual, confirmed_voice, or import.')
    }
    const input = parseJson(heroesJson, 'heroesJson')
    if (!Array.isArray(input) || input.length > 250) {
      throw new Error('heroesJson must be an array containing at most 250 hero entries.')
    }

    const seen = new Set()
    const heroes = input.map((hero, index) => {
      if (!hero || typeof hero !== 'object' || Array.isArray(hero)) {
        throw new Error(`Hero entry ${index + 1} must be an object.`)
      }
      const championId = requiredString(hero.championId, `heroesJson[${index}].championId`)
      const position = assertPosition(hero.position, `heroesJson[${index}].position`)
      const proficiency = Number(hero.proficiency)
      if (!Number.isInteger(proficiency) || proficiency < 1 || proficiency > 5) {
        throw new Error(`heroesJson[${index}].proficiency must be an integer from 1 to 5.`)
      }
      const preference = requiredString(hero.preference, `heroesJson[${index}].preference`).toLowerCase()
      if (!PREFERENCES.has(preference)) {
        throw new Error(`heroesJson[${index}].preference must be main, available, or avoid.`)
      }
      const key = `${championId.toLowerCase()}\u0000${position}`
      if (seen.has(key)) throw new Error(`Duplicate hero/position entry: ${championId}/${position}.`)
      seen.add(key)
      return { championId, position, proficiency, preference, source: profileSource }
    })

    const now = isoNow()
    return this.transaction(() => {
      this.db.prepare(`
        INSERT INTO players (player_id, display_name, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(player_id) DO UPDATE SET
          display_name = excluded.display_name,
          updated_at = excluded.updated_at
      `).run(id, name, now, now)
      this.db.prepare('DELETE FROM player_hero_pool WHERE player_id = ?').run(id)
      const insertHero = this.db.prepare(`
        INSERT INTO player_hero_pool
          (player_id, champion_id, position, proficiency, preference, source, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      for (const hero of heroes) {
        insertHero.run(id, hero.championId, hero.position, hero.proficiency, hero.preference, hero.source, now)
      }
      return this.getPlayerProfile(id)
    })
  }

  listRoster() {
    this.assertOpen()
    return this.db.prepare('SELECT player_id FROM players ORDER BY display_name, player_id')
      .all().map(row => this.getPlayerProfile(row.player_id))
  }

  startMatch({ queueType, patchVersion, playersJson }) {
    const queue = requiredString(queueType, 'queueType')
    const patch = requiredString(patchVersion, 'patchVersion')
    const players = parseJson(playersJson, 'playersJson')
    if (!Array.isArray(players) || players.length !== 5) {
      throw new Error('playersJson must contain exactly five player entries.')
    }
    const seen = new Set()
    const lineup = players.map((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`playersJson[${index}] must be an object.`)
      }
      const playerId = requiredString(entry.playerId, `playersJson[${index}].playerId`)
      if (seen.has(playerId)) throw new Error(`Duplicate playerId in lineup: ${playerId}.`)
      seen.add(playerId)
      return { playerId, position: assertPosition(entry.position, `playersJson[${index}].position`) }
    })

    const profiles = lineup.map(member => ({ ...member, profile: this.getPlayerProfile(member.playerId) }))
    const matchId = randomUUID()
    const startedAt = isoNow()
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO matches (match_id, queue_type, patch_version, status, state_revision, started_at)
        VALUES (?, ?, ?, 'active', 0, ?)
      `).run(matchId, queue, patch, startedAt)
      const insertMember = this.db.prepare(`
        INSERT INTO match_players (match_id, player_id, position, profile_snapshot_json)
        VALUES (?, ?, ?, ?)
      `)
      for (const member of profiles) {
        insertMember.run(matchId, member.playerId, member.position, JSON.stringify(member.profile))
      }
    })
    return this.getMatchContext(matchId)
  }

  getMatchRow(matchId) {
    const id = requiredString(matchId, 'matchId')
    const match = this.db.prepare(`
      SELECT match_id, queue_type, patch_version, status, state_revision, started_at, ended_at, notes
      FROM matches WHERE match_id = ?
    `).get(id)
    if (!match) throw new Error(`Unknown matchId: ${id}.`)
    return match
  }

  recordObservation({
    matchId,
    eventType,
    side,
    championId = '',
    playerId = '',
    position = '',
    certainty = '',
    source = 'manual',
    sourceEventId = '',
    observedAt = '',
  }) {
    const id = requiredString(matchId, 'matchId')
    const match = this.getMatchRow(id)
    if (match.status !== 'active') throw new Error(`BP ${id} is ${match.status}; new observations are not accepted.`)
    const type = requiredString(eventType, 'eventType').toLowerCase()
    const eventSide = requiredString(side, 'side').toLowerCase()
    if (!OBSERVATION_TYPES.has(type)) throw new Error('eventType must be pick, ban, hover, or unknown.')
    if (!OBSERVATION_SIDES.has(eventSide)) throw new Error('side must be ally or enemy.')
    const champion = championId ? requiredString(championId, 'championId') : null
    if (type !== 'unknown' && !champion) throw new Error(`${type} observations require championId.`)
    const player = playerId ? requiredString(playerId, 'playerId') : null
    const role = position ? assertPosition(position) : null
    const confidence = certainty
      ? requiredString(certainty, 'certainty').toLowerCase()
      : ['hover', 'unknown'].includes(type) ? 'uncertain' : 'confirmed'
    if (!CERTAINTIES.has(confidence)) throw new Error('certainty must be confirmed, uncertain, or low.')
    const origin = requiredString(source, 'source').toLowerCase()
    if (!SOURCES.has(origin)) throw new Error('source must be screenshot, manual, client, or import.')
    const sourceId = sourceEventId ? requiredString(sourceEventId, 'sourceEventId') : null
    const time = observedAt ? new Date(requiredString(observedAt, 'observedAt')) : new Date()
    if (!Number.isFinite(time.getTime())) throw new Error('observedAt must be a valid date/time string.')
    const timestamp = time.toISOString()

    const member = this.db.prepare('SELECT 1 AS found FROM match_players WHERE match_id = ? AND player_id = ?')
      .get(id, player)
    if (player && !member) throw new Error(`Player ${player} is not in BP ${id}.`)

    if (sourceId) {
      const duplicate = this.db.prepare('SELECT event_id FROM bp_events WHERE match_id = ? AND source_event_id = ?')
        .get(id, sourceId)
      if (duplicate) return { duplicate: true, eventId: duplicate.event_id, context: this.getMatchContext(id) }
    }

    const eventId = randomUUID()
    const sequence = this.db.prepare('SELECT COALESCE(MAX(sequence_no), 0) + 1 AS next_sequence FROM bp_events WHERE match_id = ?')
      .get(id).next_sequence
    const revision = match.state_revision + 1
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO bp_events (
          event_id, match_id, sequence_no, source_event_id, event_type, side,
          champion_id, player_id, position, certainty, source, observed_at, state_revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(eventId, id, sequence, sourceId, type, eventSide, champion, player, role, confidence, origin, timestamp, revision)
      this.db.prepare("UPDATE recommendations SET status = 'superseded' WHERE match_id = ? AND status = 'current'")
        .run(id)
      this.db.prepare('UPDATE matches SET state_revision = ? WHERE match_id = ?').run(revision, id)
    })
    return { duplicate: false, eventId, context: this.getMatchContext(id) }
  }

  getMatchContext(matchId, { playerId = '', position = '' } = {}) {
    this.assertOpen()
    const match = this.getMatchRow(matchId)
    const members = this.db.prepare(`
      SELECT mp.player_id, mp.position, mp.profile_snapshot_json
      FROM match_players AS mp WHERE mp.match_id = ?
      ORDER BY mp.position, mp.player_id
    `).all(match.match_id).map(row => ({
      playerId: row.player_id,
      position: row.position,
      profile: decodeJson(row.profile_snapshot_json),
    }))
    const eventRows = this.db.prepare(`
      SELECT event_id, sequence_no, event_type, side, champion_id, player_id, position,
        certainty, source, observed_at, state_revision
      FROM bp_events WHERE match_id = ? ORDER BY sequence_no
    `).all(match.match_id)
    const events = eventRows.map(toPublicEvent)
    const response = {
      match: {
        matchId: match.match_id,
        queueType: match.queue_type,
        patchVersion: match.patch_version,
        status: match.status,
        stateRevision: match.state_revision,
        startedAt: match.started_at,
        endedAt: match.ended_at,
        notes: match.notes,
      },
      players: members,
      events,
      confirmedUnavailableChampionIds: [...new Set(eventRows
        .filter(row => row.certainty === 'confirmed' && ['pick', 'ban'].includes(row.event_type) && row.champion_id)
        .map(row => row.champion_id))],
      patchKnowledge: {
        version: match.patch_version,
        evidenceLoaded: false,
        note: 'The patch label is user-provided. No patch statistics or strength claims are loaded by this initial plugin.',
      },
    }

    if (playerId) {
      const targetId = requiredString(playerId, 'playerId')
      const member = members.find(entry => entry.playerId === targetId)
      if (!member) throw new Error(`Player ${targetId} is not in BP ${match.match_id}.`)
      const targetPosition = position ? assertPosition(position) : member.position
      const unavailable = new Set(response.confirmedUnavailableChampionIds.map(id => id.toLowerCase()))
      const candidates = member.profile.heroes
        .filter(hero => hero.preference !== 'avoid')
        .filter(hero => hero.position === targetPosition || hero.position === 'flex')
        .filter(hero => !unavailable.has(hero.championId.toLowerCase()))
        .sort((a, b) => Number(b.preference === 'main') - Number(a.preference === 'main') || b.proficiency - a.proficiency || a.championId.localeCompare(b.championId))
      response.target = { playerId: targetId, position: targetPosition }
      response.candidates = candidates
    }

    response.recommendations = this.db.prepare(`
      SELECT recommendation_id, player_id, position, based_on_revision, candidates_json, rationale, status, created_at
      FROM recommendations WHERE match_id = ? ORDER BY created_at DESC LIMIT 5
    `).all(match.match_id).map(row => ({
      recommendationId: row.recommendation_id,
      playerId: row.player_id,
      position: row.position,
      basedOnRevision: row.based_on_revision,
      candidates: decodeJson(row.candidates_json, []),
      rationale: row.rationale,
      status: row.status,
      createdAt: row.created_at,
    }))
    return response
  }

  saveRecommendation({ matchId, playerId, position = '', basedOnRevision, candidatesJson, rationale }) {
    const id = requiredString(matchId, 'matchId')
    const targetId = requiredString(playerId, 'playerId')
    const match = this.getMatchRow(id)
    if (match.status !== 'active') throw new Error(`BP ${id} is ${match.status}; recommendations cannot be added.`)
    const member = this.db.prepare(`
      SELECT position, profile_snapshot_json FROM match_players WHERE match_id = ? AND player_id = ?
    `).get(id, targetId)
    if (!member) throw new Error(`Player ${targetId} is not in BP ${id}.`)
    const targetPosition = position ? assertPosition(position) : member.position
    const revision = Number(basedOnRevision)
    if (!Number.isInteger(revision) || revision < 0) throw new Error('basedOnRevision must be a non-negative integer.')
    const candidates = parseJson(candidatesJson, 'candidatesJson')
    if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > 3) {
      throw new Error('candidatesJson must contain one to three canonical champion IDs.')
    }
    const normalized = candidates.map((item, index) => requiredString(item, `candidatesJson[${index}]`))
    if (new Set(normalized.map(value => value.toLowerCase())).size !== normalized.length) {
      throw new Error('candidatesJson cannot contain duplicate champion IDs.')
    }
    const profile = decodeJson(member.profile_snapshot_json)
    const heroPool = new Set(profile.heroes
      .filter(hero => hero.preference !== 'avoid' && (hero.position === targetPosition || hero.position === 'flex'))
      .map(hero => hero.championId.toLowerCase()))
    const unavailable = new Set(this.getMatchContext(id).confirmedUnavailableChampionIds.map(value => value.toLowerCase()))
    for (const championId of normalized) {
      if (!heroPool.has(championId.toLowerCase())) {
        throw new Error(`${championId} is not in ${targetId}'s confirmed hero pool for ${targetPosition}.`)
      }
      if (unavailable.has(championId.toLowerCase())) throw new Error(`${championId} is already picked or banned.`)
    }
    const note = requiredString(rationale, 'rationale')
    const status = revision === match.state_revision ? 'current' : 'stale'
    const recommendationId = randomUUID()
    this.transaction(() => {
      this.db.prepare("UPDATE recommendations SET status = 'superseded' WHERE match_id = ? AND status = 'current'")
        .run(id)
      this.db.prepare(`
        INSERT INTO recommendations (
          recommendation_id, match_id, player_id, position, based_on_revision,
          candidates_json, rationale, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(recommendationId, id, targetId, targetPosition, revision, JSON.stringify(normalized), note, status, isoNow())
    })
    return { recommendationId, status, context: this.getMatchContext(id) }
  }

  finishMatch({ matchId, status, notes = '' }) {
    const id = requiredString(matchId, 'matchId')
    const finalStatus = requiredString(status, 'status').toLowerCase()
    if (!MATCH_STATUSES.has(finalStatus)) throw new Error('status must be completed, cancelled, or incomplete.')
    const match = this.getMatchRow(id)
    if (match.status !== 'active') throw new Error(`BP ${id} is already ${match.status}.`)
    const note = notes ? String(notes).trim() : null
    this.db.prepare('UPDATE matches SET status = ?, ended_at = ?, notes = ? WHERE match_id = ?')
      .run(finalStatus, isoNow(), note, id)
    return this.getMatchContext(id)
  }

  close() {
    if (this.closed) return
    this.db.close()
    this.closed = true
  }
}
