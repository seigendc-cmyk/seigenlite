-- =====================================================================
-- Back-office sign-in tokens: sign them with the project's JWT secret,
-- read from Vault, and make them well-formed.
--
-- cl_login signed its tokens with current_setting('app.settings.jwt_secret'),
-- which isn't set in this project and can't be: Supabase refuses
-- ALTER DATABASE ... SET app.settings.* ("permission denied to set
-- parameter"). With no secret, cl_sign_jwt returned NULL, so every sign-in
-- handed back a null token, calls went out without the staff claims, and
-- cl_create_rpn (and every other staff check) answered "Not authorized".
-- Also, encode(..., 'base64') wraps its output every 76 characters, so a
-- token payload contained line breaks: not a valid JWT even with a secret.
--
--   1. cl_jwt_secret(): the secret, from Vault (name 'cl_jwt_secret'); a
--      database setting still wins if one is ever set. Only the database
--      owner can run it: never exposed to anon, authenticated or
--      service_role, so no API call can read the secret.
--   2. cl_sign_jwt: base64url without line breaks or padding
--      (+ -> -, / -> _, and = \n \r removed), as JWTs require.
--   3. cl_login: reads the secret through cl_jwt_secret(), and refuses
--      clearly if it's missing instead of returning a null token. Nothing
--      else in cl_login changes.
--
-- THE SECRET ITSELF IS NOT IN THIS FILE. Store it once, by hand, in the
-- SQL editor (Project Settings -> API -> JWT Settings -> JWT Secret):
--   select vault.create_secret('<the JWT secret>', 'cl_jwt_secret',
--     'Supabase JWT secret: signs back-office sign-in tokens (cl_login)');
--
-- Previous definitions: supabase/inspect/cl_jwt_functions_before_20260926.sql
-- One transaction; the preflight stops on a name clash.
-- =====================================================================

do $$
begin
  if to_regprocedure('public.cl_login(text,text)') is null or to_regprocedure('public.cl_sign_jwt(json,text)') is null then
    raise exception 'cl_jwt_signing_fix aborted: cl_login / cl_sign_jwt not found. Nothing was changed.';
  end if;
  if to_regprocedure('public.cl_jwt_secret()') is not null then
    raise exception 'cl_jwt_signing_fix aborted: public.cl_jwt_secret() already exists. Nothing was changed.';
  end if;
end $$;


-- 1. The secret, for cl_login only.
create function public.cl_jwt_secret()
returns text
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(
    nullif(current_setting('app.settings.jwt_secret', true), ''),
    (select ds.decrypted_secret from vault.decrypted_secrets ds
      where ds.name = 'cl_jwt_secret' order by ds.created_at desc limit 1)
  )
$fn$;

revoke all on function public.cl_jwt_secret() from public, anon, authenticated, service_role;


-- 2. Well-formed base64url.
create or replace function public.cl_sign_jwt(payload json, secret text)
returns text
language plpgsql
as $fn$
declare
  header_b64  text;
  payload_b64 text;
  signing_input text;
  sig_b64 text;
begin
  -- translate(): + -> -, / -> _, and = \n \r dropped (no padding, no
  -- line breaks — encode(..., 'base64') wraps every 76 characters).
  header_b64  := translate(encode(convert_to('{"alg":"HS256","typ":"JWT"}', 'utf8'), 'base64'), '+/=' || chr(10) || chr(13), '-_');
  payload_b64 := translate(encode(convert_to(payload::text, 'utf8'), 'base64'), '+/=' || chr(10) || chr(13), '-_');
  signing_input := header_b64 || '.' || payload_b64;
  sig_b64 := translate(encode(extensions.hmac(signing_input, secret, 'sha256'), 'base64'), '+/=' || chr(10) || chr(13), '-_');
  return signing_input || '.' || sig_b64;
end;
$fn$;


-- 3. cl_login, reading the secret through cl_jwt_secret().
CREATE OR REPLACE FUNCTION public.cl_login(p_name text, p_passcode text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_staff  cl_staff%rowtype;
  v_rpn    cl_rpn%rowtype;
  v_secret text;
  v_token  text;
begin
  v_secret := public.cl_jwt_secret();
  if v_secret is null or v_secret = '' then
    raise exception 'Sign-in is not configured: the JWT secret is missing (Vault secret "cl_jwt_secret").';
  end if;

  -- Try staff first
  select * into v_staff from cl_staff where lower(full_name) = lower(p_name) and active = true;
  if found and v_staff.passcode_hash = extensions.crypt(p_passcode, v_staff.passcode_hash) then
    v_token := public.cl_sign_jwt(
      json_build_object(
        'role', 'authenticated',
        'sub', v_staff.id::text,
        'user_type', 'staff',
        'is_sysadmin', v_staff.is_sysadmin,
        'full_name', v_staff.full_name,
        'iat', extract(epoch from now())::int,
        'exp', extract(epoch from now() + interval '12 hours')::int
      ),
      v_secret
    );
    return json_build_object(
      'token', v_token,
      'user_type', 'staff',
      'id', v_staff.id,
      'full_name', v_staff.full_name,
      'is_sysadmin', v_staff.is_sysadmin
    );
  end if;

  -- Then RPN
  select * into v_rpn from cl_rpn where lower(full_name) = lower(p_name) and active = true;
  if found and v_rpn.passcode_hash = extensions.crypt(p_passcode, v_rpn.passcode_hash) then
    v_token := public.cl_sign_jwt(
      json_build_object(
        'role', 'authenticated',
        'sub', v_rpn.id::text,
        'user_type', 'rpn',
        'full_name', v_rpn.full_name,
        'iat', extract(epoch from now())::int,
        'exp', extract(epoch from now() + interval '12 hours')::int
      ),
      v_secret
    );
    return json_build_object(
      'token', v_token,
      'user_type', 'rpn',
      'id', v_rpn.id,
      'full_name', v_rpn.full_name
    );
  end if;

  raise exception 'Invalid name or passcode';
end;
$function$;
