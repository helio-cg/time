-- Migração para bancos já existentes: adiciona a coluna de movimentações
-- da partida (substituição/remoção). Seguro rodar mesmo se já existir.
ALTER TABLE matches ADD COLUMN events TEXT;
