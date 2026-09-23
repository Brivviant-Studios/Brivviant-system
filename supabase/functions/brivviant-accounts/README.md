Deploy with verify_jwt=false because login/account authorization is performed inside the function using the caller JWT.

supabase functions deploy brivviant-accounts --no-verify-jwt

The live Studio project already has this function deployed.
