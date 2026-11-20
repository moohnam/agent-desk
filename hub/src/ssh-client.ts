import { enrollmentMessage } from './ssh-enrollment.ts';
import { publicKey, signWithAgent, SSH_NAMESPACE, SSH_ENROLL_NAMESPACE } from './ssh-signature.ts';
import { HttpError } from './errors.ts';
export async function sshLogin(url:string,workspaceId:string,key:string,signal:AbortSignal) {
  const call=async(path:string,body:unknown)=>{
    const r=await fetch(new URL(path,url),{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal});
    if(!r.ok)throw new HttpError(r.status,'SSH 연결 인증에 실패했습니다. 등록한 공개키와 작업공간을 확인하세요');
    return await r.json() as any;
  };
  const {fingerprint}=publicKey(key);
  const c=await call('/v1/ssh/challenge',{workspaceId,fingerprint});
  let m:any;try{m=JSON.parse(c.message);}catch{throw new HttpError(401,'인증 요청 형식이 잘못되었습니다');}
  const expected={version:1,namespace:SSH_NAMESPACE,workspaceId,peerId:m.peerId,fingerprint,nonce:c.id,expires:c.expires};
  if(typeof c.id!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(c.id)||typeof m.peerId!=='string'||!/^[a-f0-9-]{36}$/.test(m.peerId)
    || !Number.isSafeInteger(c.expires)||c.expires<=Date.now()||c.expires>Date.now()+90_000||c.message!==JSON.stringify(expected))
    throw new HttpError(401,'서명 대상이 선택한 작업공간과 일치하지 않습니다');
  const signature=await signWithAgent(key,c.message);
  const session=await call('/v1/ssh/session',{id:c.id,signature});
  if(session.workspaceId!==workspaceId||session.peer?.fingerprint!==fingerprint||session.peer?.peerId!==m.peerId
    ||typeof session.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(session.token)||!Number.isSafeInteger(session.expires))throw new HttpError(401,'SSH 세션 응답이 잘못되었습니다');
  return {token:session.token as string,expires:session.expires as number};
}

export async function enrollmentCall(url:string, route:string, body:unknown, parent?:AbortSignal) {
  const timeout=AbortSignal.timeout(8000);
  const res = await fetch(new URL('/v1/ssh/enrollment/'+route,url),{
    method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify(body),
    signal:parent?AbortSignal.any([parent,timeout]):timeout,
  });
  if (!res.ok) throw new HttpError(res.status, '공유 러너가 SSH 연결 요청을 받지 못했습니다');
  return await res.json() as any;
}

export async function requestEnrollment(url:string, workspaceId:string, input:{ name:string; ownerName:string; publicKey:string }) {
  const { name, ownerName, publicKey: key } = input;
  const { fingerprint } = publicKey(key);
  const challenge = await enrollmentCall(url,'challenge',{workspaceId,name,ownerName,publicKey:key});
  const { id, expires } = challenge;
  if (!enrollmentId(id) || !Number.isSafeInteger(expires) || expires<=Date.now() || expires>Date.now()+90_000 ||
      challenge.message!==enrollmentMessage(workspaceId,{id,expires,fingerprint,name,ownerName}))
    throw new HttpError(401,'서명 대상이 선택한 작업공간과 일치하지 않습니다');
  const signature=await signWithAgent(key,challenge.message,SSH_ENROLL_NAMESPACE);
  const request=await enrollmentCall(url,'submit',{id,signature});
  if (!enrollmentId(request.id)) throw new HttpError(502,'연결 요청 응답이 올바르지 않습니다');
  return request.id as string;
}

function enrollmentId(id:unknown) {
  return typeof id==='string' && /^[A-Za-z0-9_-]{43}$/.test(id);
}
