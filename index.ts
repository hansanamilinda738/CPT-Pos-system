import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
const cors = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS'};
const json = (body: unknown, status=200) => new Response(JSON.stringify(body),{status,headers:{...cors,'Content-Type':'application/json'}});
Deno.serve(async req => {
  if(req.method==='OPTIONS') return new Response('ok',{headers:cors});
  if(req.method!=='POST') return json({error:'Method not allowed'},405);
  try {
    const auth=req.headers.get('Authorization')||''; if(!auth.startsWith('Bearer ')) return json({error:'Login required'},401);
    const userClient=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_ANON_KEY')!,{global:{headers:{Authorization:auth}}});
    const {data:userData,error:userError}=await userClient.auth.getUser();
    if(userError||!userData.user) return json({error:'Invalid session'},401);
    const {data:approved,error:approvalError}=await userClient.from('app_users').select('id,is_active').eq('id',userData.user.id).eq('is_active',true).maybeSingle();
    if(approvalError||!approved) return json({error:'This account is not an approved ConnectPro admin.'},403);
    const body=await req.json(), description=String(body.description||'').trim(), catalog=Array.isArray(body.catalog)?body.catalog.slice(0,500):[], files=Array.isArray(body.files)?body.files.slice(0,4):[];
    if(!description&&!files.length) return json({error:'Enter a job description or attach a BOQ/photo/PDF.'},400);
    if(files.some((f:any)=>!['image/jpeg','image/png','image/webp','application/pdf'].includes(f.type)||String(f.data||'').length>12_000_000)) return json({error:'Unsupported file or too large. Use JPG, PNG, WEBP or PDF (max 8 MB each).'},400);
    const apiKey=Deno.env.get('OPENAI_API_KEY'); if(!apiKey) return json({error:'OPENAI_API_KEY secret is not configured in Supabase Edge Functions.'},503);
    const prompt=`Prepare an engineering quotation draft from job notes and attached BOQ/photo/PDF. Extract only supported line items. Never invent quantity, unit, specification or price. Match catalog item by name; if no reliable match set catalog_match null. Catalog is the ONLY source of prices. Return JSON keys title, description, site, lines. Each line: kind (Material/Labour/Transport/Other), description, quantity, unit, catalog_match (exact catalog name or null), specification, confidence (0..1), review_note. Include labour/transport/other only if supported. Catalog: ${JSON.stringify(catalog)}`;
    const content:any[]=[{type:'input_text',text:prompt}];
    for(const f of files){const dataUrl=`data:${f.type};base64,${f.data}`; if(f.type==='application/pdf') content.push({type:'input_file',filename:f.name||'boq.pdf',file_data:dataUrl}); else content.push({type:'input_image',image_url:dataUrl,detail:'high'});}
    const response=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-4.1-mini',input:[{role:'user',content:[{type:'input_text',text:description||'Read the attached BOQ and prepare a quotation draft.'},...content]}],text:{format:{type:'json_object'}}})});
    const result=await response.json(); if(!response.ok) return json({error:result.error?.message||'AI service failed'},502);
    const output=(result.output||[]).flatMap((x:any)=>x.content||[]).find((x:any)=>x.type==='output_text')?.text; if(!output) return json({error:'AI returned no structured quotation.'},502);
    const draft=JSON.parse(output); if(!Array.isArray(draft.lines)) return json({error:'AI response format was invalid.'},502);
    draft.lines=draft.lines.slice(0,150).map((line:any)=>({kind:['Material','Labour','Transport','Other'].includes(line.kind)?line.kind:'Material',description:String(line.description||'').slice(0,500),quantity:Number.isFinite(Number(line.quantity))&&line.quantity!==null?Number(line.quantity):1,unit:String(line.unit||'pcs').slice(0,30),catalog_match:line.catalog_match?String(line.catalog_match).slice(0,200):null,specification:line.specification?String(line.specification).slice(0,500):null,confidence:Math.max(0,Math.min(1,Number(line.confidence)||0)),review_note:line.review_note?String(line.review_note).slice(0,500):null}));
    return json({draft,generated_by:userData.user.id});
  }catch(e){return json({error:e instanceof Error?e.message:'Unexpected error'},500);}
});
