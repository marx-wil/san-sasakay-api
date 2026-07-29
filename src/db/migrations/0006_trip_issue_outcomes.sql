-- 0006_trip_issue_outcomes.sql
-- Allow good/neutral post-trip outcomes in addition to incident types.

ALTER TABLE trip_feedback DROP CONSTRAINT IF EXISTS trip_feedback_trip_issue_check;

ALTER TABLE trip_feedback ADD CONSTRAINT trip_feedback_trip_issue_check
  CHECK (trip_issue IN (
    'tuloy_tuloy',
    'okay_lang',
    'aksidente',
    'baha',
    'sarado',
    'others'
  ));
