-- The live definitions of cl_login and cl_sign_jwt as they were before
-- 20260926120000_cl_jwt_signing_fix.sql, kept so they can be restored.
-- (They contain no secrets: cl_login read the secret from a setting.)

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
  select current_setting('app.settings.jwt_secret', true) into v_secret;

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

CREATE OR REPLACE FUNCTION public.cl_sign_jwt(payload json, secret text)
 RETURNS text
 LANGUAGE plpgsql
AS $function$
declare
  header_b64  text;
  payload_b64 text;
  signing_input text;
  sig_b64 text;
begin
  header_b64 := encode(convert_to('{"alg":"HS256","typ":"JWT"}', 'utf8'), 'base64');
  payload_b64 := encode(convert_to(payload::text, 'utf8'), 'base64');
  header_b64 := replace(replace(rtrim(header_b64, '='), '+', '-'), '/', '_');
  payload_b64 := replace(replace(rtrim(payload_b64, '='), '+', '-'), '/', '_');
  signing_input := header_b64 || '.' || payload_b64;
  sig_b64 := encode(extensions.hmac(signing_input, secret, 'sha256'), 'base64');
  sig_b64 := replace(replace(rtrim(sig_b64, '='), '+', '-'), '/', '_');
  return signing_input || '.' || sig_b64;
end;
$function$;
