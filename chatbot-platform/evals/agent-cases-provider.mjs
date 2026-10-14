// Evaluate the same saved business suite as the UI, through the authenticated API.
// Store the exported config in evals/; never put a session cookie in that file.
const runs = new Map();
export default class AgentCasesProvider {
  id() { return 'riverrun-agent-cases'; }
  async callApi(_prompt,context) {
    const {agent_id,revision,suite_revision,index}=context.vars;
    const url=new URL(process.env.RIVERRUN_APP_URL||'http://localhost:3000');
    if(url.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('Usa HTTPS para la app remota.');
    if(!process.env.RIVERRUN_SESSION_COOKIE) throw new Error('Configura RIVERRUN_SESSION_COOKIE de forma segura. No la incluyas en la configuración exportada.');
    const request=async(path,body)=>{
      const r=await fetch(new URL(path,url),{redirect:'error',headers:{cookie:process.env.RIVERRUN_SESSION_COOKIE,'content-type':'application/json'},...(body?{method:'POST',body:JSON.stringify(body)}:{})});
      if(!r.ok) throw new Error(`La evaluación respondió HTTP ${r.status}. Revisa la sesión, el perfil o el borrador.`);
      return r.json();
    };
    const key=`${url.origin}:${agent_id}:${revision}:${suite_revision}`;
    if(!runs.has(key)) runs.set(key,(async()=>{
      const current=await request(`/api/chatbots/${agent_id}/versions`);
      if(current.draft.revision!==revision||current.suite.revision!==suite_revision) throw new Error('El borrador o las pruebas cambiaron. Vuelve a exportar la configuración.');
      let run=await request(`/api/chatbots/${agent_id}/tests/run`,{revision});
      const deadline=Date.now()+240000;
      while(run.status==='running'&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,1500));run=await request(`/api/chatbots/${agent_id}/tests/runs/${run.id}`);}
      if(run.status==='running'||run.status==='error') throw new Error('No se completaron las pruebas. Consulta el resultado en la app.');
      return run;
    })());
    const run=await runs.get(key),result=run.results[index];
    if(!result) throw new Error('Caso no encontrado en la evaluación.');
    return {output:JSON.stringify(result)};
  }
}
