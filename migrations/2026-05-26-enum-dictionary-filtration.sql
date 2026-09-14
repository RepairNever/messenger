ALTER TABLE enum_dictionary
    ADD COLUMN IF NOT EXISTS participates_in_filtration boolean NOT NULL DEFAULT false;
