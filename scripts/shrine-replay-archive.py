#!/usr/bin/env python3
"""Resumable November 1, 2026 Solana launch/trade collector using Shrine's free public replay."""
import hashlib, json, os, subprocess, sys, tempfile, io
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
import requests, zstandard

BASE = "https://replay.shrine.trade/pump"
ROOT = Path(os.getenv("DATA_DIR", "./historical-data"))
START = int(datetime(2026, 11, 1, tzinfo=timezone.utc).timestamp())
END = int(datetime(2026, 11, 2, tzinfo=timezone.utc).timestamp())
WINDOW = 600
MAX_HOURS = max(1, int(os.getenv("REPLAY_MAX_HOURS_PER_RUN", "3")))
LAUNCHES = {"PUMPFUN", "PUMPFUN_MAYHEM", "STONKFUN"}
TRADES = LAUNCHES | {"PUMPSWAP"}
QUOTE_DECIMALS = {
 "So11111111111111111111111111111111111111112": 9,
 "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": 6,
 "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": 6,
}
ROOT.mkdir(parents=True, exist_ok=True)
CP = ROOT / "checkpoint.json"
S = requests.Session()
S.headers.update({"User-Agent": "solana-scalping-research/1.0"})

def log(event, **kw):
 print(json.dumps({"event": event, **kw}, separators=(",", ":"), default=str), flush=True)

def load():
 if CP.exists():
  s=json.loads(CP.read_text())
  if (s.get("schemaVersion"),s.get("start"),s.get("end")) != (1,START,END):
   raise RuntimeError("Checkpoint/date mismatch; refusing to mix collection windows.")
 else: s={"schemaVersion":1,"start":START,"end":END,"programs":{},"launches":{}}
 s.setdefault("replayHours",{}); s.setdefault("launches",{}); s.setdefault("tradeCursors",{})
 if s.get("collectorVersion") != 2:
  s["replayHours"]={}; s["collectorVersion"]=2
 return s

def save(s):
 p=CP.with_suffix(".tmp"); p.write_text(json.dumps(s,separators=(",",":"))+"\n"); p.replace(CP)

def paths(r):
 shard=hashlib.sha256(r["mint"].encode()).hexdigest()[:2]
 ld=ROOT/"launches"/r["venue"]/shard; td=ROOT/"trades"/r["venue"]/shard/r["mint"]
 ld.mkdir(parents=True,exist_ok=True); td.mkdir(parents=True,exist_ok=True)
 return ld,td

def dump(p,x): p.write_text(json.dumps(x,separators=(",",":"),default=str)+"\n")
def append(p,xs):
 if xs:
  with p.open("a",encoding="utf-8") as f:
   for x in xs: f.write(json.dumps(x,separators=(",",":"),default=str)+"\n")

def make_launch(e):
 ts=int(e.get("timestamp") or 0); mint=e.get("mint"); sig=e.get("signature")
 if not isinstance(mint,str) or not mint or not START<=ts<END: return None
 if not sig: raise RuntimeError("Launch create event missing signature.")
 return {"venue":"stonkfun" if e.get("protocol")=="STONKFUN" else "pumpfun",
         "mint":mint,"signature":str(sig),"slot":int(e.get("block") or 0),
         "blockTime":ts,"creator":e.get("creator"),"feePayer":e.get("txSigner"),
         "quoteMint":e.get("quoteMint"),"pool":e.get("pool"),"decimals":e.get("decimals"),
         "providerProtocol":e.get("protocol")}

def persist_launch(r,e):
 ld,_=paths(r)
 dump(ld/f"{r['mint']}.json",{
  "schemaVersion":1,"recordType":"historical_launch","historicalWindow":{"start":START,"end":END},
  **r,"observedAt":datetime.now(timezone.utc).isoformat(),
  "transaction":{"signature":r["signature"],"slot":r["slot"],"blockTime":r["blockTime"],
   "feeLamports":e.get("txFeeLamports"),"priorityFeeLamports":e.get("priorityFeeLamports"),
   "tipLamports":e.get("tipLamports"),"computeUnitsConsumed":e.get("computeUnitsConsumed"),
   "txIndex":e.get("txIndex"),"initialBuy":e.get("initialBuy"),
   "mintAuthority":e.get("mintAuthority"),"freezeAuthority":e.get("freezeAuthority"),
   "tokenExtensions":e.get("tokenExtensions") or [],"supply":e.get("supply"),"supplyRaw":e.get("supplyRaw"),
   "tokensInPool":e.get("tokensInPool"),"quoteInPool":e.get("quoteInPool"),
   "tokensInPoolRaw":e.get("tokensInPoolRaw"),"quoteInPoolRaw":e.get("quoteInPoolRaw")},
  "dataQuality":{"source":"shrine_public_hourly_replay","launchTimestampFromBlockTime":True,
   "launchEventDecodedByProvider":True,"rawProviderEventRetained":True,
   "historicalHolderSnapshot":False,"lockedLiquidityVerified":False},"rawProviderEvent":e})
 dump(ld/f"{r['mint']}.screening.json",{
  "schemaVersion":1,"venue":r["venue"],"mint":r["mint"],"launchSignature":r["signature"],
  "launchTime":r["blockTime"],"ruleVersion":"initial-security-gate-v1","overallStatus":"unverified",
  "security":{"status":"unverified","mintAuthority":e.get("mintAuthority"),
   "freezeAuthority":e.get("freezeAuthority"),"tokenExtensions":e.get("tokenExtensions") or [],
   "liquidityLockStatus":"unavailable",
   "reason":"The replay includes create-time authority fields, but does not establish historical locked liquidity or holder distribution."},
  "dataQuality":{"source":"shrine_public_hourly_replay","lockedLiquidityHistoricallyVerified":False,
   "historicalHolderSnapshot":False}})

def trade_row(r,e,idx):
 qm=e.get("quoteMint"); trader=e.get("trader")
 if not trader:
  ti=e.get("tradersInvolved")
  if isinstance(ti,list) and ti:
   first=ti[0]; trader=(first.get("wallet") or first.get("trader")) if isinstance(first,dict) else first
 if not trader: trader=e.get("txSigner")
 return {"schemaVersion":1,"recordType":"historical_trade_event","venue":r["venue"],"mint":r["mint"],
  "launchSignature":r["signature"],"signature":e.get("signature"),"slot":e.get("block"),
  "blockTime":e.get("timestamp"),"secondsSinceLaunch":int(e.get("timestamp") or 0)-r["blockTime"],
  "eventIndex":idx,"side":e.get("action"),"user":trader,"creator":r.get("creator"),
  "launchFeePayer":r.get("feePayer"),"launchSlot":r["slot"],"launchTime":r["blockTime"],
  "transactionFeePayer":e.get("txSigner"),"transactionFeeLamports":e.get("txFeeLamports"),
  "priorityFeeLamports":e.get("priorityFeeLamports"),"tipLamports":e.get("tipLamports"),
  "computeUnitsConsumed":e.get("computeUnitsConsumed"),"tokenAmountRaw":str(e.get("tokenAmountRaw") or "0"),
  "tokenDecimals":e.get("decimals",r.get("decimals")),"quoteMint":qm,"quoteAmountRaw":str(e.get("quoteAmountRaw") or "0"),
  "quoteDecimals":QUOTE_DECIMALS.get(qm),"pool":e.get("pool"),"protocol":e.get("protocol"),
  "txIndex":e.get("txIndex"),"tradersInvolved":e.get("tradersInvolved"),
  "breakdown":e.get("breakdown"),"fees":e.get("fees") or {},
  "reserveEvidence":{"tokensInPool":e.get("tokensInPool"),"quoteInPool":e.get("quoteInPool"),
   "tokensInPoolRaw":e.get("tokensInPoolRaw"),"quoteInPoolRaw":e.get("quoteInPoolRaw"),
   "virtualQuoteReserves":e.get("virtualQuoteReserves")},
  "impliedQuotePrice":str(e.get("price")) if e.get("price") is not None else None,
  "fundingSources":[],"providerSource":"shrine_public_hourly_replay","rawProviderRecord":e,
  "dataQuality":{"decodedProgramEventFromReplay":True,"historicalHolderSnapshot":False,"priceUsd":None,
   "traderMayBeRelayed":trader==e.get("txSigner")}}

def summarize(s,r):
 ld,td=paths(r); pages=sorted(td.glob("*.jsonl")); rows=[]
 for p in pages:
  for line in p.read_text(encoding="utf-8").splitlines():
   if line.strip():
    x=json.loads(line)
    if x.get("recordType")=="historical_trade_event": rows.append(x)
 buyers=set(); sellers=set(); vol=defaultdict(lambda:{"buys":0,"sells":0,"buyVolume":0.0,"sellVolume":0.0})
 txfee={}; priority={}; tips={}; prices=[]; buckets=set(); creator_sells=0; early=set(); top=defaultdict(float); fee_totals=defaultdict(float)
 for x in rows:
  side=x.get("side"); user=x.get("user"); qm=x.get("quoteMint") or "unknown"
  dec=x.get("quoteDecimals"); raw=int(x.get("quoteAmountRaw") or 0)
  amount=raw/(10**dec) if isinstance(dec,int) and 0<=dec<=18 else 0
  if side=="buy":
   vol[qm]["buys"]+=1; vol[qm]["buyVolume"]+=amount
   if user: buyers.add(user); top[user]+=amount
   if user and int(x.get("secondsSinceLaunch") or 0)<=5: early.add(user)
  elif side=="sell":
   vol[qm]["sells"]+=1; vol[qm]["sellVolume"]+=amount
   if user: sellers.add(user)
   if user==r.get("creator"): creator_sells+=1
  sig=x.get("signature")
  if sig and isinstance(x.get("transactionFeeLamports"),int): txfee[sig]=x["transactionFeeLamports"]
  if sig and isinstance(x.get("priorityFeeLamports"),int): priority[sig]=x["priorityFeeLamports"]
  if sig and isinstance(x.get("tipLamports"),int): tips[sig]=x["tipLamports"]
  for fee_name, fee_value in (x.get("fees") or {}).items():
   if isinstance(fee_value,(int,float)): fee_totals[fee_name]+=float(fee_value)
   elif isinstance(fee_value,dict):
    for sub_name,sub_value in fee_value.items():
     if isinstance(sub_value,(int,float)): fee_totals[f"{fee_name}.{sub_name}"]+=float(sub_value)
  try:
   price=float(x.get("impliedQuotePrice"))
   if price>0: prices.append((int(x.get("blockTime") or 0),int(x.get("slot") or 0),price))
  except (TypeError,ValueError): pass
  off=int(x.get("secondsSinceLaunch") or 0)
  if 0<=off<=WINDOW: buckets.add(min(off//10,59))
 prices.sort(); peak=0; dd=0
 for _,_,p in prices:
  peak=max(peak,p)
  if peak: dd=max(dd,(peak-p)/peak*100)
 through=int(s.get("processedThrough",START)); complete=through>=r["blockTime"]+WINDOW
 first=prices[0][2] if prices else None; last=prices[-1][2] if prices else None
 top_share=max(top.values())/sum(top.values())*100 if sum(top.values()) else None
 summary={"schemaVersion":1,"recordType":"historical_launch_research_summary","venue":r["venue"],"mint":r["mint"],
  "source":"shrine_public_hourly_replay","sourcePageCount":len(pages),"sourcePageFiles":[p.name for p in pages],
  "sourcePageFingerprint":hashlib.sha256("".join(p.name+hashlib.sha256(p.read_bytes()).hexdigest() for p in pages).encode()).hexdigest(),
  "launchSignature":r["signature"],"launchTime":r["blockTime"],"launchSlot":r["slot"],
  "creator":r.get("creator"),"launchFeePayer":r.get("feePayer"),
  "tradeEvents":{"total":len(rows),"buys":sum(v["buys"] for v in vol.values()),
   "sells":sum(v["sells"] for v in vol.values()),"uniqueBuyers":len(buyers),"uniqueSellers":len(sellers),
   "uniqueTraders":len(buyers|sellers),"creatorSellEvents":creator_sells,
   "buyersWithinFirst5Seconds":len(early),"topBuyerShareOfBuyVolume":top_share},
  "volumeByQuoteMint":dict(vol),"pricePath":{"observations":len(prices),"firstPrice":first,"lastPrice":last,
   "maxDrawdownPct":dd,"unit":"quote asset per token; not USD"},
  "networkFees":{"uniqueTransactions":len(txfee),"transactionFeeLamports":sum(txfee.values()),
   "priorityFeeLamports":sum(priority.values()),"tipLamports":sum(tips.values())},
  "protocolAndVenueFees":dict(fee_totals),
  "developerActivity":{"creator":r.get("creator"),"creatorSellEvents":creator_sells,"launchFeePayer":r.get("feePayer")},
  "capture":{"windowSeconds":WINDOW,"transactionHistoryComplete":complete,"complete":False,"researchReady":False,
   "timeCoverage":{"bucketSeconds":10,"bucketCount":60,"observedBuckets":sorted(buckets),
    "emptyBuckets":[i for i in range(60) if i not in buckets],
    "earliestObservedSecondsAfterLaunch":min((int(x.get("secondsSinceLaunch") or 0) for x in rows),default=None),
    "latestObservedSecondsAfterLaunch":max((int(x.get("secondsSinceLaunch") or 0) for x in rows),default=None),
    "gapAccountingComplete":complete,"bucketInterpretation":"Event presence in this replay source; an empty bucket does not prove no on-chain activity."},
   "totalSourcePages":len(pages),"sources":{"shrine_hourly_replay":{"complete":complete,"pages":len(pages)}},
   "completionBlockers":["historical_usd_price_unavailable","historical_holder_snapshots_unavailable",
    "locked_liquidity_not_verified","failed_transaction_history_not_in_replay"]},
  "venueStateClassification":{"launchVenue":r["venue"],"bondingCurveStatus":"event_reserve_evidence_only",
   "lockedLiquidityStatus":"unverified","safetyClassification":"unverified"},
  "dataQuality":{"tradeSource":"public replay event archive","rawEventsRetained":True,
   "failedTransactions":"not supplied by replay stream","walletLabels":"heuristics only; no bot/sniper identity asserted"}}
 dump(ld/f"{r['mint']}.summary.json",summary)
 screen=json.loads((ld/f"{r['mint']}.screening.json").read_text())
 screen["behaviouralMetrics"]=summary["tradeEvents"]; screen["overallStatus"]="unverified"
 dump(ld/f"{r['mint']}.screening.json",screen)
 return complete

def publish(changed):
 normalised=[]
 for raw in changed:
  p=Path(raw)
  try: p=p.relative_to(ROOT)
  except ValueError: pass
  normalised.append(p.as_posix())
 cmd=[sys.executable,"scripts/hf-dataset-v3-sync.py","publish-batch",*sorted(normalised)]
 subprocess.run(cmd,check=True)

def download(hour):
 url=f"{BASE}/{hour}.jsonl.zst"
 with S.get(url,stream=True,timeout=(30,300)) as res:
  if res.status_code==404: raise RuntimeError(f"Replay archive missing hour {hour}; refusing false completion.")
  res.raise_for_status()
  with tempfile.NamedTemporaryFile(prefix="replay-",suffix=".zst",delete=False) as f:
   p=Path(f.name)
   for chunk in res.iter_content(1024*1024):
    if chunk: f.write(chunk)
 return p

def process_hour(hour,s):
 p=download(hour); h=hashlib.sha256()
 with p.open("rb") as f:
  for chunk in iter(lambda:f.read(1024*1024),b""): h.update(chunk)
 digest=h.hexdigest(); changed=set(); touched=set(); initialized_pages=set(); group=[]; current=None
 counts={"events":0,"launches":0,"trades":0}
 start_hour=datetime.strptime(hour,"%Y/%m/%d/%H").replace(tzinfo=timezone.utc).timestamp()
 end_hour=start_hour+3600
 def flush():
  for idx,e in enumerate(group):
   mint=e.get("mint"); r=s["launches"].get(mint) if isinstance(mint,str) else None
   if not r or e.get("action") not in ("buy","sell") or e.get("protocol") not in TRADES: continue
   ts=int(e.get("timestamp") or 0); off=ts-r["blockTime"]
   if not 0<=off<=WINDOW: continue
   _,td=paths(r); page=td/f"replay-{hour.replace('/','')}.jsonl"
   if page not in initialized_pages:
    page.write_text("",encoding="utf-8"); initialized_pages.add(page)
   append(page,[trade_row(r,e,idx)]); changed.add(page.as_posix()); touched.add(mint); counts["trades"]+=1
 try:
  with p.open("rb") as raw:
   reader=zstandard.ZstdDecompressor().stream_reader(raw)
   for line in io.TextIOWrapper(reader,encoding="utf-8"):
    if not line.strip(): continue
    e=json.loads(line); counts["events"]+=1; sig=e.get("signature")
    if current is not None and sig!=current: flush(); group=[]
    current=sig
    if e.get("action")=="create" and e.get("protocol") in LAUNCHES:
     r=make_launch(e)
     if r:
      mint=r["mint"]; old=s["launches"].get(mint)
      if old and (old.get("signature")!=r["signature"] or old.get("blockTime")!=r["blockTime"]):
       raise RuntimeError(f"Conflicting launch identity for {mint}")
      if not old:
       s["launches"][mint]=r; persist_launch(r,e); ld,_=paths(r)
       changed.update([ (ld/f"{mint}.json").as_posix(),(ld/f"{mint}.screening.json").as_posix() ])
       counts["launches"]+=1
      else:
       ld,_=paths(old)
       if not (ld/f"{mint}.json").exists():
        persist_launch(old,e)
        changed.update([(ld/f"{mint}.json").as_posix(),(ld/f"{mint}.screening.json").as_posix()])
    group.append(e)
   flush()
  s["replayHours"][hour]={"complete":True,"sha256":digest,**counts}
  s["processedThrough"]=int(end_hour)
  candidates=set(touched)|{m for m,r in s["launches"].items() if r["blockTime"]<end_hour and r["blockTime"]+WINDOW>=start_hour}
  for mint in sorted(candidates):
   r=s["launches"][mint]; ld,td=paths(r); done=summarize(s,r)
   changed.update([(ld/f"{mint}.summary.json").as_posix(),(ld/f"{mint}.screening.json").as_posix()])
   cur=s["tradeCursors"].setdefault(mint,{"complete":False,"pages":0,"sources":{}})
   cur["pages"]=len(list(td.glob("*.jsonl"))); cur["complete"]=done
  save(s)
  log("replay_hour_complete",hour=hour,compressedBytes=p.stat().st_size,sha256=digest,**counts,
   totalLaunches=len(s["launches"]),changedCoins=len(candidates),
   processedThroughUtc=datetime.fromtimestamp(end_hour,timezone.utc).isoformat())
  publish(changed)
 finally: p.unlink(missing_ok=True)

def main():
 s=load()
 index=S.get(f"{BASE}/index.json",timeout=30); index.raise_for_status()
 available=set(index.json().get("hours",[]))
 required=[f"2026/11/01/{h:02d}" for h in range(24)]+["2026/11/02/00"]
 missing=[h for h in required if h not in available]
 if missing: raise RuntimeError(f"Public archive missing required hours: {missing[:10]}. No fallback or completion claim.")
 pending=[h for h in required if not s["replayHours"].get(h,{}).get("complete")]
 log("replay_start",source="shrine_public_hourly_replay",noApiKey=True,launchStart="2026-11-01T00:00:00Z",
  launchEndExclusive="2026-11-02T00:00:00Z",captureSeconds=WINDOW,requiredHours=len(required),
  completedHours=len(required)-len(pending),pendingHours=len(pending),existingLaunches=len(s["launches"]),maxHours=MAX_HOURS)
 for hour in pending[:MAX_HOURS]: process_hour(hour,s)
 log("replay_progress",completedHours=len(s["replayHours"]),requiredHours=len(required),
  remainingHours=len(required)-len(s["replayHours"]),launches=len(s["launches"]))
 if not pending: log("replay_complete",launches=len(s["launches"]),hours=len(required))
if __name__=="__main__":
 try: main()
 except Exception as e:
  log("replay_failed",error=str(e)); raise
