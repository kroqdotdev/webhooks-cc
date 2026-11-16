-- 00109: signature mismatch results no longer carry the expected signature
--
-- The receiver used to store the HMAC it computed ("expected") in
-- requests.signature_error next to the one received. Anyone who could read
-- the request and send to the endpoint could use it to sign any body with
-- the endpoint's stored secret. The receiver stops writing it, the web app
-- strips it on read, and this removes it from rows already stored, because
-- team members can read their team's requests through PostgREST too.
--
-- Apply it AFTER the release with the new receiver is deployed (or apply it
-- again then): until then the old receiver keeps writing "expected". The
-- update is idempotent.
--
-- signature_error is text holding JSON. A plain update: production held no
-- such rows when this was written; count them before applying, since
-- requests_broadcast_signature sends one Realtime signal per changed row and
-- the tenant has rate limits. It scans requests once (no index on the
-- column); that lock does not block captures. Rows that are not valid JSON are left
-- alone (the receiver only ever wrote JSON with "expected").
update public.requests
   set signature_error = (signature_error::jsonb - 'expected')::text
 where signature_error like '%"expected"%'
   -- CASE, so the cast only runs on text that starts as a JSON object.
   and case when signature_error ~ '^\s*\{'
            then (signature_error::jsonb) ? 'expected'
            else false
       end;
