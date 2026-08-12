//+------------------------------------------------------------------+
//|                                      TelegramSignalReceiver.mq5  |
//| Pulls authenticated Forex signals from the local webhook server. |
//+------------------------------------------------------------------+
#property strict
#property version   "1.00"
#property description "Nhan JSON tu webhook Telegram va dat lenh tren MetaTrader 5"

#include <Trade/Trade.mqh>

input group "Webhook"
input string InpWebhookUrl       = "http://127.0.0.1:8787";
input string InpWebhookToken     = "";
input string InpTerminalId       = "mt5-main";
input int    InpPollSeconds      = 1;
input int    InpHttpTimeoutMs    = 3000;

input group "Trade"
input string InpTradeSymbol      = "XAUUSD";
input double InpLots             = 0.01;
input ulong  InpMagicNumber      = 560013;
input int    InpDeviationPoints  = 20;
input bool   InpEnableLiveTrading = false;

struct TradeSignal
  {
   string id;
   string type;
   double entry;
   double tp;
   double sl;
  };

CTrade g_trade;
bool   g_request_in_progress=false;
string g_last_signal_id="";

//+------------------------------------------------------------------+
string Trimmed(string value)
  {
   StringTrimLeft(value);
   StringTrimRight(value);
   return value;
  }

//+------------------------------------------------------------------+
string BaseUrl()
  {
   string value=Trimmed(InpWebhookUrl);
   while(StringLen(value)>0 && StringSubstr(value,StringLen(value)-1,1)=="/")
      value=StringSubstr(value,0,StringLen(value)-1);
   return value;
  }

//+------------------------------------------------------------------+
bool IsValidTerminalId(const string value)
  {
   int length=StringLen(value);
   if(length<1 || length>64)
      return false;

   for(int index=0; index<length; index++)
     {
      ushort character=StringGetCharacter(value,index);
      bool allowed=(character>='A' && character<='Z') ||
                   (character>='a' && character<='z') ||
                   (character>='0' && character<='9') ||
                   character=='_' || character=='-';
      if(!allowed)
         return false;
     }
   return true;
  }

//+------------------------------------------------------------------+
string JsonEscape(string value)
  {
   StringReplace(value,"\\","\\\\");
   StringReplace(value,"\"","\\\"");
   StringReplace(value,"\r","\\r");
   StringReplace(value,"\n","\\n");
   return value;
  }

//+------------------------------------------------------------------+
bool JsonGetString(const string json,const string key,string &value)
  {
   string marker="\""+key+"\"";
   int key_position=StringFind(json,marker);
   if(key_position<0)
      return false;

   int colon_position=StringFind(json,":",key_position+StringLen(marker));
   if(colon_position<0)
      return false;

   int start=colon_position+1;
   while(start<StringLen(json))
     {
      string character=StringSubstr(json,start,1);
      if(character!=" " && character!="\t" && character!="\r" && character!="\n")
         break;
      start++;
     }

   if(start>=StringLen(json) || StringSubstr(json,start,1)!="\"")
      return false;

   start++;
   int finish=StringFind(json,"\"",start);
   if(finish<0)
      return false;

   value=StringSubstr(json,start,finish-start);
   return true;
  }

//+------------------------------------------------------------------+
int HttpRequest(const string method,const string path,const string body,string &response_body)
  {
   string headers="Authorization: Bearer "+InpWebhookToken+"\r\n"+
                  "Content-Type: application/json\r\n"+
                  "Cache-Control: no-store\r\n";
   char request_data[];
   char response_data[];
   string response_headers;

   if(body!="")
     {
      int copied=StringToCharArray(body,request_data,0,WHOLE_ARRAY,CP_UTF8);
      if(copied>0)
         ArrayResize(request_data,copied-1);
     }
   else
      ArrayResize(request_data,0);

   ResetLastError();
   int http_status=WebRequest(method,BaseUrl()+path,headers,InpHttpTimeoutMs,
                              request_data,response_data,response_headers);
   if(http_status==-1)
     {
      int error_code=GetLastError();
      PrintFormat("Webhook WebRequest failed. error=%d url=%s",error_code,BaseUrl());
      if(error_code==4014)
         Print("Them ",BaseUrl()," vao Tools > Options > Expert Advisors > Allow WebRequest for listed URL.");
      response_body="";
      return -1;
     }

   response_body=CharArrayToString(response_data,0,ArraySize(response_data),CP_UTF8);
   return http_status;
  }

//+------------------------------------------------------------------+
bool FetchNextSignal(TradeSignal &signal)
  {
   string response="";
   int status=HttpRequest("GET","/api/signals/next?terminal_id="+InpTerminalId,"",response);
   if(status<0)
      return false;
   if(status!=200)
     {
      PrintFormat("Webhook GET returned HTTP %d: %s",status,response);
      return false;
     }

   response=Trimmed(response);
   if(response=="" || response=="{}")
      return false;

   string entry_text="",tp_text="",sl_text="";
   if(!JsonGetString(response,"id",signal.id) ||
      !JsonGetString(response,"type",signal.type) ||
      !JsonGetString(response,"entry",entry_text) ||
      !JsonGetString(response,"TP",tp_text) ||
      !JsonGetString(response,"SL",sl_text))
     {
      Print("Webhook returned malformed signal JSON: ",response);
      return false;
     }

   signal.entry=(entry_text=="" ? 0.0 : StringToDouble(entry_text));
   signal.tp=StringToDouble(tp_text);
   signal.sl=StringToDouble(sl_text);
   return true;
  }

//+------------------------------------------------------------------+
bool AcknowledgeSignal(const string id,const string status,const string detail)
  {
   string payload="{\"terminal_id\":\""+JsonEscape(InpTerminalId)+
                  "\",\"status\":\""+JsonEscape(status)+
                  "\",\"detail\":\""+JsonEscape(detail)+"\"}";
   string response="";
   int http_status=HttpRequest("POST","/api/signals/"+id+"/ack",payload,response);
   if(http_status!=200)
     {
      PrintFormat("Webhook ACK failed. HTTP %d: %s",http_status,response);
      return false;
     }
   return true;
  }

//+------------------------------------------------------------------+
string StateFileName()
  {
   return "TelegramSignalReceiver_"+InpTerminalId+".state";
  }

//+------------------------------------------------------------------+
void LoadLastSignalId()
  {
   int handle=FileOpen(StateFileName(),FILE_READ|FILE_TXT|FILE_ANSI|FILE_COMMON);
   if(handle==INVALID_HANDLE)
      return;
   g_last_signal_id=FileReadString(handle);
   FileClose(handle);
  }

//+------------------------------------------------------------------+
bool SaveLastSignalId(const string id)
  {
   int handle=FileOpen(StateFileName(),FILE_WRITE|FILE_TXT|FILE_ANSI|FILE_COMMON);
   if(handle==INVALID_HANDLE)
     {
      PrintFormat("Cannot persist signal ID. error=%d",GetLastError());
      return false;
     }
   FileWriteString(handle,id);
   FileClose(handle);
   return true;
  }

//+------------------------------------------------------------------+
bool ValidateVolume(double &volume,string &detail)
  {
   double minimum=SymbolInfoDouble(InpTradeSymbol,SYMBOL_VOLUME_MIN);
   double maximum=SymbolInfoDouble(InpTradeSymbol,SYMBOL_VOLUME_MAX);
   double step=SymbolInfoDouble(InpTradeSymbol,SYMBOL_VOLUME_STEP);

   if(InpLots<minimum || InpLots>maximum || step<=0.0)
     {
      detail=StringFormat("Invalid lot %.8f; broker min=%.8f max=%.8f step=%.8f",
                          InpLots,minimum,maximum,step);
      return false;
     }

   double steps=MathRound((InpLots-minimum)/step);
   double aligned=NormalizeDouble(minimum+steps*step,8);
   if(MathAbs(aligned-InpLots)>0.00000001)
     {
      detail=StringFormat("Lot %.8f is not aligned to broker step %.8f",InpLots,step);
      return false;
     }

   volume=aligned;
   return true;
  }

//+------------------------------------------------------------------+
bool ValidatePrices(const TradeSignal &signal,const string type,string &detail)
  {
   if(signal.tp<=0.0 || signal.sl<=0.0)
     {
      detail="TP or SL is not a positive number";
      return false;
     }

   MqlTick tick;
   if(!SymbolInfoTick(InpTradeSymbol,tick))
     {
      detail="Cannot read current Bid/Ask";
      return false;
     }

   if(type=="buy" || type=="buy now")
     {
      if(signal.sl>=tick.ask || signal.tp<=tick.ask)
        {
         detail="BUY requires SL below Ask and TP above Ask";
         return false;
        }
      return true;
     }

   if(type=="sell" || type=="sell now")
     {
      if(signal.sl<=tick.bid || signal.tp>=tick.bid)
        {
         detail="SELL requires SL above Bid and TP below Bid";
         return false;
        }
      return true;
     }

   if(signal.entry<=0.0)
     {
      detail="Pending order requires a positive entry";
      return false;
     }

   if(type=="buy limit" &&
      (signal.entry>=tick.ask || signal.sl>=signal.entry || signal.tp<=signal.entry))
     {
      detail="BUY LIMIT requires entry below Ask, SL below entry, TP above entry";
      return false;
     }
   if(type=="sell limit" &&
      (signal.entry<=tick.bid || signal.sl<=signal.entry || signal.tp>=signal.entry))
     {
      detail="SELL LIMIT requires entry above Bid, SL above entry, TP below entry";
      return false;
     }
   if(type=="buy stop" &&
      (signal.entry<=tick.ask || signal.sl>=signal.entry || signal.tp<=signal.entry))
     {
      detail="BUY STOP requires entry above Ask, SL below entry, TP above entry";
      return false;
     }
   if(type=="sell stop" &&
      (signal.entry>=tick.bid || signal.sl<=signal.entry || signal.tp>=signal.entry))
     {
      detail="SELL STOP requires entry below Bid, SL above entry, TP below entry";
      return false;
     }

   if(type!="buy limit" && type!="sell limit" && type!="buy stop" && type!="sell stop")
     {
      detail="Unsupported order type: "+type;
      return false;
     }
   return true;
  }

//+------------------------------------------------------------------+
bool IsSuccessfulRetcode(const uint retcode)
  {
   return retcode==TRADE_RETCODE_DONE ||
          retcode==TRADE_RETCODE_PLACED ||
          retcode==TRADE_RETCODE_DONE_PARTIAL;
  }

//+------------------------------------------------------------------+
bool PlaceSignal(const TradeSignal &signal,string &detail)
  {
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) ||
      !MQLInfoInteger(MQL_TRADE_ALLOWED) ||
      !AccountInfoInteger(ACCOUNT_TRADE_ALLOWED))
     {
      detail="AutoTrading or account trading permission is disabled";
      return false;
     }

   double volume=0.0;
   if(!ValidateVolume(volume,detail))
      return false;

   string type=signal.type;
   StringToLower(type);
   if(!ValidatePrices(signal,type,detail))
      return false;

   int digits=(int)SymbolInfoInteger(InpTradeSymbol,SYMBOL_DIGITS);
   double entry=NormalizeDouble(signal.entry,digits);
   double sl=NormalizeDouble(signal.sl,digits);
   double tp=NormalizeDouble(signal.tp,digits);
   string comment="TG:"+StringSubstr(signal.id,0,20);
   bool sent=false;

   g_trade.SetTypeFillingBySymbol(InpTradeSymbol);
   if(type=="buy" || type=="buy now")
      sent=g_trade.Buy(volume,InpTradeSymbol,0.0,sl,tp,comment);
   else if(type=="sell" || type=="sell now")
      sent=g_trade.Sell(volume,InpTradeSymbol,0.0,sl,tp,comment);
   else if(type=="buy limit")
      sent=g_trade.BuyLimit(volume,entry,InpTradeSymbol,sl,tp,ORDER_TIME_GTC,0,comment);
   else if(type=="sell limit")
      sent=g_trade.SellLimit(volume,entry,InpTradeSymbol,sl,tp,ORDER_TIME_GTC,0,comment);
   else if(type=="buy stop")
      sent=g_trade.BuyStop(volume,entry,InpTradeSymbol,sl,tp,ORDER_TIME_GTC,0,comment);
   else if(type=="sell stop")
      sent=g_trade.SellStop(volume,entry,InpTradeSymbol,sl,tp,ORDER_TIME_GTC,0,comment);

   uint retcode=g_trade.ResultRetcode();
   detail=StringFormat("retcode=%u %s order=%I64u deal=%I64u",
                       retcode,g_trade.ResultRetcodeDescription(),
                       g_trade.ResultOrder(),g_trade.ResultDeal());
   return sent && IsSuccessfulRetcode(retcode);
  }

//+------------------------------------------------------------------+
int OnInit()
  {
   if(StringLen(Trimmed(InpWebhookToken))<16)
     {
      Print("InpWebhookToken must contain at least 16 characters.");
      return INIT_PARAMETERS_INCORRECT;
     }
   if(!IsValidTerminalId(InpTerminalId))
     {
      Print("InpTerminalId may contain only A-Z, a-z, 0-9, _ and -.");
      return INIT_PARAMETERS_INCORRECT;
     }
   if(BaseUrl()=="")
      return INIT_PARAMETERS_INCORRECT;
   if(!SymbolSelect(InpTradeSymbol,true))
     {
      Print("Cannot select trade symbol: ",InpTradeSymbol);
      return INIT_FAILED;
     }

   g_trade.SetExpertMagicNumber(InpMagicNumber);
   g_trade.SetDeviationInPoints(InpDeviationPoints);
   g_trade.SetAsyncMode(false);
   LoadLastSignalId();

   if(!EventSetTimer((int)MathMax(1,InpPollSeconds)))
     {
      PrintFormat("EventSetTimer failed. error=%d",GetLastError());
      return INIT_FAILED;
     }

   Print("Add ",BaseUrl()," to Tools > Options > Expert Advisors > Allow WebRequest for listed URL.");
   Print("Live trading is ",InpEnableLiveTrading ? "ENABLED" : "DISABLED (dry-run mode)",".");
   return INIT_SUCCEEDED;
  }

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   EventKillTimer();
  }

//+------------------------------------------------------------------+
void OnTimer()
  {
   if(g_request_in_progress)
      return;
   g_request_in_progress=true;

   TradeSignal signal;
   if(!FetchNextSignal(signal))
     {
      g_request_in_progress=false;
      return;
     }

   if(signal.id==g_last_signal_id)
     {
      AcknowledgeSignal(signal.id,"duplicate","Signal ID already processed by this EA");
      g_request_in_progress=false;
      return;
     }

   string result_status="";
   string detail="";

   if(!InpEnableLiveTrading)
     {
      result_status="dry_run";
      detail=StringFormat("Dry run: type=%s symbol=%s lots=%.8f entry=%.8f TP=%.8f SL=%.8f",
                          signal.type,InpTradeSymbol,InpLots,signal.entry,signal.tp,signal.sl);
      Print(detail);
     }
   else if(PlaceSignal(signal,detail))
     {
      result_status="executed";
      Print("Trade accepted: ",detail);
     }
   else
     {
      result_status="rejected";
      Print("Trade rejected: ",detail);
     }

   g_last_signal_id=signal.id;
   SaveLastSignalId(signal.id);
   AcknowledgeSignal(signal.id,result_status,detail);
   g_request_in_progress=false;
  }
//+------------------------------------------------------------------+
