//+------------------------------------------------------------------+
//|                                      TelegramSignalReceiver.mq5  |
//| Pulls authenticated Forex signals from the local webhook server. |
//+------------------------------------------------------------------+
#property strict
#property version   "1.15"
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
input double InpTakeProfitPips   = 200.0;
input double InpPipSize          = 0.1;
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

enum ENUM_SIGNAL_EXECUTION_RESULT
  {
   SIGNAL_EXECUTION_FAILED=0,
   SIGNAL_EXECUTION_EXECUTED=1,
   SIGNAL_EXECUTION_SKIPPED=2
  };

CTrade g_trade;
bool   g_request_in_progress=false;
string g_last_signal_id="";
int    g_consecutive_sl=0;
ulong  g_last_progression_deal=0;

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
string ProgressionStateFileName()
  {
   string safe_symbol="";
   for(int index=0; index<StringLen(InpTradeSymbol); index++)
     {
      ushort character=StringGetCharacter(InpTradeSymbol,index);
      bool allowed=(character>='A' && character<='Z') ||
                   (character>='a' && character<='z') ||
                   (character>='0' && character<='9') ||
                   character=='_' || character=='-' || character=='.';
      safe_symbol+=(allowed ? StringSubstr(InpTradeSymbol,index,1) : "_");
     }

   return "TelegramSignalReceiver_"+InpTerminalId+"_"+
          (string)AccountInfoInteger(ACCOUNT_LOGIN)+"_"+safe_symbol+"_"+
          (string)InpMagicNumber+".progression";
  }

//+------------------------------------------------------------------+
bool SaveProgressionState()
  {
   int handle=FileOpen(ProgressionStateFileName(),FILE_WRITE|FILE_TXT|FILE_ANSI|FILE_COMMON);
   if(handle==INVALID_HANDLE)
     {
      PrintFormat("Cannot persist lot progression. error=%d",GetLastError());
      return false;
     }

   FileWrite(handle,"3");
   FileWrite(handle,(string)AccountInfoInteger(ACCOUNT_LOGIN));
   FileWrite(handle,InpTradeSymbol);
   FileWrite(handle,(string)InpMagicNumber);
   FileWrite(handle,IntegerToString(g_consecutive_sl));
   FileWrite(handle,(string)g_last_progression_deal);
   FileClose(handle);
   return true;
  }

//+------------------------------------------------------------------+
bool LoadProgressionState()
  {
   int handle=FileOpen(ProgressionStateFileName(),FILE_READ|FILE_TXT|FILE_ANSI|FILE_COMMON);
   if(handle==INVALID_HANDLE)
      return false;

   string version=FileReadString(handle);
   string saved_account=FileReadString(handle);
   string saved_symbol=FileReadString(handle);
   string saved_magic=FileReadString(handle);
   string streak=FileReadString(handle);
   string last_deal=FileReadString(handle);
   FileClose(handle);

   if(version!="3" ||
      (long)StringToInteger(saved_account)!=AccountInfoInteger(ACCOUNT_LOGIN) ||
      saved_symbol!=InpTradeSymbol ||
      (ulong)StringToInteger(saved_magic)!=InpMagicNumber)
      return false;

   g_consecutive_sl=(int)MathMax(0,StringToInteger(streak));
   g_last_progression_deal=(ulong)StringToInteger(last_deal);
   return true;
  }

//+------------------------------------------------------------------+
bool GetTrackedExitReason(const ulong deal_ticket,ENUM_DEAL_REASON &reason)
  {
   if(deal_ticket==0)
      return false;
   if(HistoryDealGetString(deal_ticket,DEAL_SYMBOL)!=InpTradeSymbol)
      return false;
   if((ulong)HistoryDealGetInteger(deal_ticket,DEAL_MAGIC)!=InpMagicNumber)
      return false;

   ENUM_DEAL_ENTRY entry=(ENUM_DEAL_ENTRY)HistoryDealGetInteger(deal_ticket,DEAL_ENTRY);
   if(entry!=DEAL_ENTRY_OUT && entry!=DEAL_ENTRY_OUT_BY)
      return false;

   reason=(ENUM_DEAL_REASON)HistoryDealGetInteger(deal_ticket,DEAL_REASON);
   return reason==DEAL_REASON_SL || reason==DEAL_REASON_TP;
  }

//+------------------------------------------------------------------+
void ApplyProgressionResult(const ulong deal_ticket,const ENUM_DEAL_REASON reason)
  {
   if(deal_ticket==0 || deal_ticket==g_last_progression_deal)
      return;

   if(reason==DEAL_REASON_SL)
     {
      g_consecutive_sl++;
      PrintFormat("Tracked position hit SL. Consecutive SL=%d; next lot=%.8f",
                  g_consecutive_sl,InpLots*(g_consecutive_sl+1));
     }
   else if(reason==DEAL_REASON_TP)
     {
      g_consecutive_sl=0;
      PrintFormat("Tracked position hit TP. Lot progression reset to %.8f",InpLots);
     }

   g_last_progression_deal=deal_ticket;
   SaveProgressionState();
  }

//+------------------------------------------------------------------+
void SynchronizeProgressionState(const bool state_loaded)
  {
   if(!HistorySelect(0,TimeCurrent()))
     {
      PrintFormat("Cannot select deal history for lot progression. error=%d",GetLastError());
      return;
     }

   ulong tickets[];
   ENUM_DEAL_REASON reasons[];
   int total=HistoryDealsTotal();
   for(int index=0; index<total; index++)
     {
      ulong ticket=HistoryDealGetTicket(index);
      ENUM_DEAL_REASON reason;
      if(!GetTrackedExitReason(ticket,reason))
         continue;

      int count=ArraySize(tickets);
      ArrayResize(tickets,count+1);
      ArrayResize(reasons,count+1);
      tickets[count]=ticket;
      reasons[count]=reason;
     }

   int count=ArraySize(tickets);
   if(!state_loaded)
     {
      // Existing account history predates installation of this version. Use it
      // only as a baseline so an old SL does not unexpectedly increase the lot.
      g_consecutive_sl=0;
      g_last_progression_deal=(count>0 ? tickets[count-1] : 0);
      SaveProgressionState();
      return;
     }

   int start=0;
   if(g_last_progression_deal!=0)
     {
      start=-1;
      for(int index=0; index<count; index++)
        {
         if(tickets[index]==g_last_progression_deal)
           {
            start=index+1;
            break;
           }
        }

      if(start<0)
        {
         // The broker may have pruned old history. Preserve the current streak
         // and establish a new baseline instead of replaying unknown old deals.
         g_last_progression_deal=(count>0 ? tickets[count-1] : 0);
         SaveProgressionState();
         return;
        }
     }

   for(int index=start; index<count; index++)
      ApplyProgressionResult(tickets[index],reasons[index]);
  }

//+------------------------------------------------------------------+
bool ValidateVolume(const double requested_volume,double &volume,string &detail)
  {
   double minimum=SymbolInfoDouble(InpTradeSymbol,SYMBOL_VOLUME_MIN);
   double maximum=SymbolInfoDouble(InpTradeSymbol,SYMBOL_VOLUME_MAX);
   double step=SymbolInfoDouble(InpTradeSymbol,SYMBOL_VOLUME_STEP);

   if(requested_volume<minimum || requested_volume>maximum || step<=0.0)
     {
      detail=StringFormat("Invalid lot %.8f; broker min=%.8f max=%.8f step=%.8f",
                          requested_volume,minimum,maximum,step);
      return false;
     }

   double steps=MathRound((requested_volume-minimum)/step);
   double aligned=NormalizeDouble(minimum+steps*step,8);
   if(MathAbs(aligned-requested_volume)>0.00000001)
     {
      detail=StringFormat("Lot %.8f is not aligned to broker step %.8f",requested_volume,step);
      return false;
     }

   volume=aligned;
   return true;
  }

//+------------------------------------------------------------------+
bool ApplyCappedTakeProfit(TradeSignal &signal,const string type,string &detail)
  {
   if(InpTakeProfitPips<=0.0 || InpPipSize<=0.0)
     {
      detail="InpTakeProfitPips and InpPipSize must be positive";
      return false;
     }

   bool is_buy=(type=="buy" || type=="buy now" ||
                type=="buy limit" || type=="buy stop");
   bool is_sell=(type=="sell" || type=="sell now" ||
                 type=="sell limit" || type=="sell stop");
   if(!is_buy && !is_sell)
     {
      detail="Unsupported order type: "+type;
      return false;
     }

   double reference_entry=signal.entry;
   if(type=="buy" || type=="buy now" || type=="sell" || type=="sell now")
     {
      MqlTick tick;
      if(!SymbolInfoTick(InpTradeSymbol,tick))
        {
         detail="Cannot read current Bid/Ask for TP selection";
         return false;
        }
      reference_entry=(is_buy ? tick.ask : tick.bid);
     }

   if(reference_entry<=0.0)
     {
      detail="Cannot calculate forced TP without a positive entry";
      return false;
     }

   double maximum_distance=InpTakeProfitPips*InpPipSize;
   double capped_tp=reference_entry+(is_buy ? maximum_distance : -maximum_distance);
   if(capped_tp<=0.0)
     {
      detail="Calculated capped TP is not positive";
      return false;
     }

   double original_tp=signal.tp;
   double original_profit_distance=(is_buy ? original_tp-reference_entry :
                                             reference_entry-original_tp);
   bool use_original_tp=(original_tp>0.0 &&
                         original_profit_distance>0.0 &&
                         original_profit_distance<maximum_distance);
   double selected_tp=(use_original_tp ? original_tp : capped_tp);

   double tick_size=SymbolInfoDouble(InpTradeSymbol,SYMBOL_TRADE_TICK_SIZE);
   if(tick_size>0.0)
      selected_tp=MathRound(selected_tp/tick_size)*tick_size;

   int digits=(int)SymbolInfoInteger(InpTradeSymbol,SYMBOL_DIGITS);
   signal.tp=NormalizeDouble(selected_tp,digits);
   detail=(use_original_tp ? "AI" : "CAP");
   return true;
  }

//+------------------------------------------------------------------+
bool ValidatePrices(const TradeSignal &signal,const string type,string &detail)
  {
   bool allows_empty_sl=(type=="buy now" || type=="sell now" ||
                         type=="buy limit" || type=="sell limit" ||
                         type=="buy stop" || type=="sell stop");
   if(signal.tp<=0.0)
     {
      detail="TP is not a positive number";
      return false;
     }
   if(signal.sl<0.0 || (!allows_empty_sl && signal.sl<=0.0))
     {
      detail="SL is required for plain BUY and SELL orders";
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
      if((signal.sl>0.0 && signal.sl>=tick.ask) || signal.tp<=tick.ask)
        {
         detail="BUY requires any supplied SL below Ask and TP above Ask";
         return false;
        }
      return true;
     }

   if(type=="sell" || type=="sell now")
     {
      if((signal.sl>0.0 && signal.sl<=tick.bid) || signal.tp>=tick.bid)
        {
         detail="SELL requires any supplied SL above Bid and TP below Bid";
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
      (signal.entry>=tick.ask ||
       (signal.sl>0.0 && signal.sl>=signal.entry) || signal.tp<=signal.entry))
     {
      detail="BUY LIMIT requires entry below Ask, any supplied SL below entry, and TP above entry";
      return false;
     }
   if(type=="sell limit" &&
      (signal.entry<=tick.bid ||
       (signal.sl>0.0 && signal.sl<=signal.entry) || signal.tp>=signal.entry))
     {
      detail="SELL LIMIT requires entry above Bid, any supplied SL above entry, and TP below entry";
      return false;
     }
   if(type=="buy stop" &&
      (signal.entry<=tick.ask ||
       (signal.sl>0.0 && signal.sl>=signal.entry) || signal.tp<=signal.entry))
     {
      detail="BUY STOP requires entry above Ask, any supplied SL below entry, and TP above entry";
      return false;
     }
   if(type=="sell stop" &&
      (signal.entry>=tick.bid ||
       (signal.sl>0.0 && signal.sl<=signal.entry) || signal.tp>=signal.entry))
     {
      detail="SELL STOP requires entry below Bid, any supplied SL above entry, and TP below entry";
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
bool IsBuySignalType(const string type)
  {
   return type=="buy" || type=="buy now" ||
          type=="buy limit" || type=="buy stop";
  }

//+------------------------------------------------------------------+
bool IsSellSignalType(const string type)
  {
   return type=="sell" || type=="sell now" ||
          type=="sell limit" || type=="sell stop";
  }

//+------------------------------------------------------------------+
bool PendingOrderTypeForSignal(const string type,ENUM_ORDER_TYPE &order_type)
  {
   if(type=="buy limit")
     {
      order_type=ORDER_TYPE_BUY_LIMIT;
      return true;
     }
   if(type=="sell limit")
     {
      order_type=ORDER_TYPE_SELL_LIMIT;
      return true;
     }
   if(type=="buy stop")
     {
      order_type=ORDER_TYPE_BUY_STOP;
      return true;
     }
   if(type=="sell stop")
     {
      order_type=ORDER_TYPE_SELL_STOP;
      return true;
     }
   return false;
  }

//+------------------------------------------------------------------+
double PriceComparisonTolerance()
  {
   double tick_size=SymbolInfoDouble(InpTradeSymbol,SYMBOL_TRADE_TICK_SIZE);
   if(tick_size<=0.0)
      tick_size=SymbolInfoDouble(InpTradeSymbol,SYMBOL_POINT);
   return (tick_size>0.0 ? tick_size*0.5 : 0.00000001);
  }

//+------------------------------------------------------------------+
bool PricesMatch(const double first,const double second)
  {
   return MathAbs(first-second)<=PriceComparisonTolerance()+0.000000000001;
  }

//+------------------------------------------------------------------+
bool FindDuplicatePendingOrder(const string type,const double entry,ulong &order_ticket)
  {
   ENUM_ORDER_TYPE expected_type;
   if(!PendingOrderTypeForSignal(type,expected_type))
      return false;

   int total=OrdersTotal();
   for(int index=0; index<total; index++)
     {
      ulong ticket=OrderGetTicket(index);
      if(ticket==0)
         continue;
      if(OrderGetString(ORDER_SYMBOL)!=InpTradeSymbol ||
         (ulong)OrderGetInteger(ORDER_MAGIC)!=InpMagicNumber ||
         (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE)!=expected_type)
         continue;
      if(!PricesMatch(OrderGetDouble(ORDER_PRICE_OPEN),entry))
         continue;

      order_ticket=ticket;
      return true;
     }
   return false;
  }

//+------------------------------------------------------------------+
void AnalyzeMatchingPositions(const bool incoming_is_buy,
                              const double incoming_sl,
                              int &same_direction_count,
                              double &maximum_same_direction_volume,
                              bool &same_sl_exists,
                              ulong &same_sl_ticket,
                              ulong &opposite_tickets[])
  {
   same_direction_count=0;
   maximum_same_direction_volume=0.0;
   same_sl_exists=false;
   same_sl_ticket=0;
   ArrayResize(opposite_tickets,0);

   int total=PositionsTotal();
   for(int index=0; index<total; index++)
     {
      ulong ticket=PositionGetTicket(index);
      if(ticket==0)
         continue;
      if(PositionGetString(POSITION_SYMBOL)!=InpTradeSymbol ||
         (ulong)PositionGetInteger(POSITION_MAGIC)!=InpMagicNumber)
         continue;

      ENUM_POSITION_TYPE position_type=(ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
      bool position_is_buy=(position_type==POSITION_TYPE_BUY);
      bool position_is_sell=(position_type==POSITION_TYPE_SELL);
      if(!position_is_buy && !position_is_sell)
         continue;

      if(position_is_buy==incoming_is_buy)
        {
         same_direction_count++;
         maximum_same_direction_volume=MathMax(maximum_same_direction_volume,
                                               PositionGetDouble(POSITION_VOLUME));
         if(PricesMatch(PositionGetDouble(POSITION_SL),incoming_sl))
           {
            same_sl_exists=true;
            same_sl_ticket=ticket;
           }
        }
      else
        {
         int count=ArraySize(opposite_tickets);
         ArrayResize(opposite_tickets,count+1);
         opposite_tickets[count]=ticket;
        }
     }
  }

//+------------------------------------------------------------------+
bool CloseOppositePositions(const ulong &tickets[],string &detail)
  {
   int total=ArraySize(tickets);
   for(int index=0; index<total; index++)
     {
      ulong ticket=tickets[index];
      bool sent=g_trade.PositionClose(ticket,(ulong)InpDeviationPoints);
      uint retcode=g_trade.ResultRetcode();
      if(!sent || !IsSuccessfulRetcode(retcode))
        {
         detail=StringFormat("Cannot close opposite position #%I64u: retcode=%u %s",
                             ticket,retcode,g_trade.ResultRetcodeDescription());
         return false;
        }
      if(PositionSelectByTicket(ticket))
        {
         detail=StringFormat("Opposite position #%I64u remains open after close request",ticket);
         return false;
        }

      PrintFormat("Closed opposite position #%I64u before processing the new signal.",ticket);
     }
   return true;
  }

//+------------------------------------------------------------------+
ENUM_SIGNAL_EXECUTION_RESULT PlaceSignal(const TradeSignal &signal,string &detail)
  {
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) ||
      !MQLInfoInteger(MQL_TRADE_ALLOWED) ||
      !AccountInfoInteger(ACCOUNT_TRADE_ALLOWED))
     {
      detail="AutoTrading or account trading permission is disabled";
      return SIGNAL_EXECUTION_FAILED;
     }

   string type=Trimmed(signal.type);
   StringToLower(type);
   TradeSignal effective_signal=signal;
   if(!ApplyCappedTakeProfit(effective_signal,type,detail))
      return SIGNAL_EXECUTION_FAILED;
   string tp_source=detail;
   if(!ValidatePrices(effective_signal,type,detail))
      return SIGNAL_EXECUTION_FAILED;

   int digits=(int)SymbolInfoInteger(InpTradeSymbol,SYMBOL_DIGITS);
   double entry=NormalizeDouble(effective_signal.entry,digits);
   double sl=NormalizeDouble(effective_signal.sl,digits);
   double tp=NormalizeDouble(effective_signal.tp,digits);

   ENUM_ORDER_TYPE pending_order_type;
   bool is_pending=PendingOrderTypeForSignal(type,pending_order_type);
   ulong duplicate_order_ticket=0;
   if(is_pending && FindDuplicatePendingOrder(type,entry,duplicate_order_ticket))
     {
      detail=StringFormat("Skipped duplicate pending order #%I64u: type=%s entry=%s",
                          duplicate_order_ticket,type,DoubleToString(entry,digits));
      return SIGNAL_EXECUTION_SKIPPED;
     }

   bool incoming_is_buy=IsBuySignalType(type);
   if(!incoming_is_buy && !IsSellSignalType(type))
     {
      detail="Unsupported order type: "+type;
      return SIGNAL_EXECUTION_FAILED;
     }

   int same_direction_count=0;
   double maximum_same_direction_volume=0.0;
   bool same_sl_exists=false;
   ulong same_sl_ticket=0;
   ulong opposite_tickets[];
   AnalyzeMatchingPositions(incoming_is_buy,sl,same_direction_count,
                            maximum_same_direction_volume,
                            same_sl_exists,same_sl_ticket,opposite_tickets);

   ENUM_ACCOUNT_MARGIN_MODE margin_mode=(ENUM_ACCOUNT_MARGIN_MODE)AccountInfoInteger(ACCOUNT_MARGIN_MODE);
   if(same_direction_count>0 && !same_sl_exists &&
      margin_mode!=ACCOUNT_MARGIN_MODE_RETAIL_HEDGING)
     {
      detail="Cannot keep separate same-direction positions with different SL on a netting/exchange account";
      return SIGNAL_EXECUTION_FAILED;
     }

   double requested_volume=InpLots*(g_consecutive_sl+1);
   if(same_direction_count>0)
      requested_volume=maximum_same_direction_volume+InpLots;
   double volume=0.0;
   if(!same_sl_exists && !ValidateVolume(requested_volume,volume,detail))
      return SIGNAL_EXECUTION_FAILED;

   if(!CloseOppositePositions(opposite_tickets,detail))
      return SIGNAL_EXECUTION_FAILED;

   if(same_sl_exists)
     {
      detail=StringFormat("Skipped same-direction signal: position #%I64u already has SL=%s; closed_opposite=%d",
                          same_sl_ticket,(sl>0.0 ? DoubleToString(sl,digits) : "NONE"),
                          ArraySize(opposite_tickets));
      return SIGNAL_EXECUTION_SKIPPED;
     }

   string comment="TG:"+StringSubstr(signal.id,0,20);
   bool sent=false;

   if(sl<=0.0)
      Print("WARNING: placing ",type," without Stop Loss because the Telegram signal omitted SL.");

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
   string sl_detail=(sl>0.0 ? DoubleToString(sl,digits) : "NONE");
   detail=StringFormat("lots=%.8f SL=%s selected_TP=%.8f TP_source=%s same_positions=%d closed_opposite=%d retcode=%u %s order=%I64u deal=%I64u",
                       volume,sl_detail,tp,tp_source,same_direction_count,
                       ArraySize(opposite_tickets),
                       retcode,g_trade.ResultRetcodeDescription(),
                       g_trade.ResultOrder(),g_trade.ResultDeal());
   return (sent && IsSuccessfulRetcode(retcode) ?
           SIGNAL_EXECUTION_EXECUTED : SIGNAL_EXECUTION_FAILED);
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
   if(InpLots<=0.0 || InpTakeProfitPips<=0.0 || InpPipSize<=0.0)
     {
      Print("InpLots, InpTakeProfitPips and InpPipSize must be positive.");
      return INIT_PARAMETERS_INCORRECT;
     }
   if(!SymbolSelect(InpTradeSymbol,true))
     {
      Print("Cannot select trade symbol: ",InpTradeSymbol);
      return INIT_FAILED;
     }

   g_trade.SetExpertMagicNumber(InpMagicNumber);
   g_trade.SetDeviationInPoints(InpDeviationPoints);
   g_trade.SetAsyncMode(false);
   LoadLastSignalId();
   bool progression_state_loaded=LoadProgressionState();
   SynchronizeProgressionState(progression_state_loaded);

   if(!EventSetTimer((int)MathMax(1,InpPollSeconds)))
     {
      PrintFormat("EventSetTimer failed. error=%d",GetLastError());
      return INIT_FAILED;
     }

   Print("Add ",BaseUrl()," to Tools > Options > Expert Advisors > Allow WebRequest for listed URL.");
   Print("Live trading is ",InpEnableLiveTrading ? "ENABLED" : "DISABLED (dry-run mode)",".");
   PrintFormat("Lot progression: consecutive SL=%d next lot=%.8f. TP cap=%.2f pips x %.8f price units.",
               g_consecutive_sl,InpLots*(g_consecutive_sl+1),
               InpTakeProfitPips,InpPipSize);
   return INIT_SUCCEEDED;
  }

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   EventKillTimer();
  }

//+------------------------------------------------------------------+
void OnTradeTransaction(const MqlTradeTransaction &trans,
                        const MqlTradeRequest &request,
                        const MqlTradeResult &result)
  {
   if(trans.type!=TRADE_TRANSACTION_DEAL_ADD || trans.deal==0)
      return;
   if(!HistoryDealSelect(trans.deal))
      return;

   ENUM_DEAL_REASON reason;
   if(GetTrackedExitReason(trans.deal,reason))
      ApplyProgressionResult(trans.deal,reason);
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
      double dry_run_lots=InpLots*(g_consecutive_sl+1);
      TradeSignal dry_run_signal=signal;
      string dry_run_type=signal.type;
      StringToLower(dry_run_type);
      string tp_detail="";
      ApplyCappedTakeProfit(dry_run_signal,dry_run_type,tp_detail);
      result_status="dry_run";
      detail=StringFormat("Dry run: type=%s symbol=%s lots=%.8f entry=%.8f TP=%.8f TP_source=%s SL=%.8f",
                          signal.type,InpTradeSymbol,dry_run_lots,signal.entry,
                          dry_run_signal.tp,tp_detail,signal.sl);
      Print(detail);
     }
   else
     {
      ENUM_SIGNAL_EXECUTION_RESULT execution_result=PlaceSignal(signal,detail);
      if(execution_result==SIGNAL_EXECUTION_EXECUTED)
        {
         result_status="executed";
         Print("Trade accepted: ",detail);
        }
      else if(execution_result==SIGNAL_EXECUTION_SKIPPED)
        {
         result_status="duplicate";
         Print("Trade skipped: ",detail);
        }
      else
        {
         result_status="rejected";
         Print("Trade rejected: ",detail);
        }
     }

   g_last_signal_id=signal.id;
   SaveLastSignalId(signal.id);
   AcknowledgeSignal(signal.id,result_status,detail);
   g_request_in_progress=false;
  }
//+------------------------------------------------------------------+
