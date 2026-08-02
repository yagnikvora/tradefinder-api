-- MomentumConfig / MomentumSnapshot / MomentumHistory — the PostgreSQL schema.
--
-- NOT WIRED UP. This deployment stores the same three records as JSON under
-- `api/.cache/momentum/` (see `store.ts`), which is what the rest of this app does and what
-- was asked for. This file is the migration for the day that stops being enough — the
-- repository interfaces in `config/config.repository.ts`, `data/snapshot.repository.ts` and
-- `data/history.repository.ts` are already the seam, so switching is a new driver class per
-- interface and one line in `momentum/index.ts`. Nothing above those three files changes.
--
-- The one table that genuinely wants a database is `momentum_history`: it is append-mostly,
-- one row per symbol per session, and it is what IV Rank is eventually built from. At 208
-- symbols × 250 sessions a year it is ~52k rows a year — fine as JSON for a while, and
-- obviously a table once you want to query across it.

BEGIN;

-- ---------------------------------------------------------------- MomentumConfig ----
-- Versioned rather than updated in place: a board carries the config version it was scored
-- under, and being able to answer "what were the weights when this ranked 1st?" is the
-- difference between an audit trail and a shrug.
CREATE TABLE IF NOT EXISTS momentum_config (
    version      INTEGER      PRIMARY KEY,
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_by   TEXT         NOT NULL,
    weights      JSONB        NOT NULL,
    scoring      JSONB        NOT NULL,
    confidence   JSONB        NOT NULL,
    thresholds   JSONB        NOT NULL,
    universe     JSONB        NOT NULL,
    refresh      JSONB        NOT NULL,
    output       JSONB        NOT NULL
);

COMMENT ON TABLE momentum_config IS
    'One row per saved configuration. The active model is the highest version.';

CREATE INDEX IF NOT EXISTS momentum_config_updated_at_idx
    ON momentum_config (updated_at DESC);

-- -------------------------------------------------------------- MomentumSnapshot ----
-- The computed board. `board` is the whole payload so a snapshot can be replayed exactly as
-- it was served, including the warnings — a score that is reproducible only if you still
-- have the inputs is not reproducible.
CREATE TABLE IF NOT EXISTS momentum_snapshot (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    as_of           TIMESTAMPTZ NOT NULL,
    config_version  INTEGER     NOT NULL REFERENCES momentum_config (version),
    universe_size   INTEGER     NOT NULL,
    scored          INTEGER     NOT NULL,
    shortlisted     INTEGER     NOT NULL,
    market          JSONB       NOT NULL,
    board           JSONB       NOT NULL,
    warnings        TEXT[]      NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS momentum_snapshot_as_of_idx
    ON momentum_snapshot (as_of DESC);

-- --------------------------------------------------------------- MomentumHistory ----
-- One row per symbol per session. The `atm_iv` column is the whole reason this exists:
-- Upstox publishes implied volatility as of now and nothing historical, so IV Rank and IV
-- Percentile are only computable from a series this table accumulates. See
-- `data/history.repository.ts`.
CREATE TABLE IF NOT EXISTS momentum_history (
    symbol       TEXT        NOT NULL,
    day          DATE        NOT NULL,
    close        NUMERIC(14, 4) NOT NULL,
    score        NUMERIC(5, 2)  NOT NULL,
    direction    TEXT        NOT NULL CHECK (direction IN ('Bullish', 'Bearish', 'Neutral')),
    rvol         NUMERIC(8, 3),
    atm_iv       NUMERIC(8, 3),
    hv20         NUMERIC(8, 3),
    futures_oi   BIGINT,
    recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (symbol, day)
);

COMMENT ON COLUMN momentum_history.atm_iv IS
    'ATM implied volatility at the last scan of the session. Accumulates the IV history '
    'Upstox does not publish; IV Rank needs ~20 rows per symbol before it is meaningful.';

CREATE INDEX IF NOT EXISTS momentum_history_symbol_day_idx
    ON momentum_history (symbol, day DESC);

-- The IV-rank query this table exists to serve.
-- SELECT atm_iv FROM momentum_history
--  WHERE symbol = $1 AND atm_iv IS NOT NULL
--  ORDER BY day DESC LIMIT 252;

COMMIT;
