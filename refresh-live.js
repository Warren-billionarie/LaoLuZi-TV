// Usage: node refresh-live.js [--out=path/to/live.txt]
// Requires Node >= 18 (fetch + crypto are built-in)

const crypto = require('crypto');
const fs = require('fs');

// ---- source A ----
const SOURCE_A = {
  API_BASE: 'https://kapi.kankanews.com',
  VERSION: '2.41.6',
  SIGN_SALT: '28c8edde3d61a0411511d3b1866f0636',
  M_UUID: 'WpVSBr0vgkBhWrNMzimQC',
  PUB_KEY: `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDP5hzPUW5RFeE2xBT1ERB3hHZI
Votn/qatWhgc1eZof09qKjElFN6Nma461ZAwGpX4aezKP8Adh4WJj4u2O54xCXDt
wzKRqZO2oNZkuNmF2Va8kLgiEQAAcxYc8JgTN+uQQNpsep4n/o1sArTJooZIF17E
tSqSgXDcJ7yDj5rc7wIDAQAB
-----END PUBLIC KEY-----`,
};

const SOURCE_A_CHANNELS = [
  { id: 10, name: '五星体育', group: '体育' },
  { id: 12, name: '新纪实', group: '纪实' },
];

const SOURCE_A_HEADERS = {
  'Referer': 'https://live.kankanews.com/',
  'Origin': 'https://live.kankanews.com',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
};

// ---- source B ----
// yibababa 2026-06 改版:(1) 频道名 "体育/赛事" 改成 "线路";(2) 所有 URL 都包了
// 播放器壳 .../player/{tcplayer,dplayer,mpegts}/?url=<真URL> 或 cors-proxy.cooks.fyi/<真URL>,
// 必须 unwrap() 剥壳才能拿到真实可播 URL;(3) ESPN/Eurosport 从 cctv5.txt 移到 sport.txt。
// 故 SOURCE_B 拆成多 feed,每个 wanted 指明从哪个 feed 取。
const SOURCE_B = {
  ORIGIN: 'https://yibababa.com',
  FEEDS: {
    cctv5: 'https://yibababa.com/tv/cctv5/cctv5.txt',
    sport: 'https://yibababa.com/tv/sport/sport.txt',
  },
};

const SOURCE_B_WANTED = [
  // CCTV5 / CCTV5+ 均不再走 yibababa feed 探活,改为下方 C5_FALLBACKS / C5P_FALLBACKS 全显式列源(精确控制线路顺序)
  { feed: 'sport', match: /^Eurosport 1,/, alias: 'Eurosport 1', headers: {} },
  // ESPN: yibababa 已删纯 ESPN,仅剩死的 "ESPN 2"(143.244.60.30 connection refused),暂撤,待新源
];

const SOURCE_B_EXTRA = [];

// ---- source C ----
const SOURCE_C = {
  API_BASE: 'https://emas-api.cctvnews.cctv.com/h5/emas.feed.article.live.detail/1.0.0',
  HMAC_KEY: 'emasgatewayh5',
  APP_KEY: '20000009',
  SCENE_TYPE: 6,
  TIMEOUT_MS: 8000,
};

const SOURCE_C_CHANNELS = [];

const C9_FALLBACKS = [
  { url: 'http://74.91.26.218:82/live/cctv9hd.m3u8', headers: {} },
  { url: 'https://timetv.shop/http://74.91.26.218:82/live/cctv9hd.m3u8', headers: { Origin: 'https://yibababa.com' } },
  // 3) 咪咕壳(mg.cttv.vip→miguvideo 中国移动 CDN),H.264 720p25+AAC,无 header/壳现取 token 不过期。
  //    线路1/2 同为 74.91 单机后端,此线是唯一独立 CDN,74.91 挂时靠它兜底(2026-07-01 US 实测 ~1MB/s≈3x 余量;跨太平洋 + 会 flap,故列末位)
  { url: 'http://mg.cttv.vip/673168140', headers: {} },
  // 4) udpxy 组播中继(上海电信,CCTV9 只有 HD 1080p ~8.5Mbps),独立故障域末位兜底;实时转发零余量,跨洋 8Mbps 波动易卡(2026-07-06 US 测实时比 0.99x)。SD 段无 CCTV9,只此一条
  { url: 'http://58.35.123.183:3333/rtp/233.18.204.75:5140', headers: {} },
];

const C13_FALLBACKS = [
  // 1) 咪咕壳(mg.cttv.vip→miguvideo 中国移动 CDN),实测 720p H.264 25fps+AAC(路径写 SD 实为 1280×720),无 header/壳现取 token。
  //    独立故障域(不走 zbdq4/74.91),用户 2026-07-17 给的优质源,提为主力线路1(US 实测 ~1.6x 余量)
  { url: 'http://mg.cttv.vip/608807423', headers: {} },
  // 2) 美国堪萨斯城 Nocix(zbdq4 源站家族,同 CCTV5/周星驰/周润发/动作电影的 198.204.228.26),302→198.204.229.186:82,720p H.264 25fps+AAC,无 key/无 header。
  //    用户 2026-07-17 报旧线(74.91)不能看后指定换此源(US 实测 .ts 2.7MB/s≈13x 余量,std 干净真画面)
  { url: 'http://198.204.228.26/live/cctv13hd.m3u8', headers: {} },
  { url: 'http://74.91.26.218:82/live/cctv13hd.m3u8', headers: {} },
  { url: 'https://timetv.shop/http://74.91.26.218:82/live/cctv13hd.m3u8', headers: { Origin: 'https://yibababa.com' } },
  // 3) udpxy 组播中继(上海电信,SD 720×576 ~2.8Mbps),独立故障域末位兜底;实时转发零余量+私人盒子,跨洋波动会卡(2026-07-06 US 测实时比 0.99x)。同盒 HD 版 233.18.204.79:5140 未用
  { url: 'http://58.35.123.183:3333/rtp/233.18.204.32:5140', headers: {} },
];

// 五星体育线路:线路1 udpxy 组播中继(上海电信,H.264 Main 720×576 + MP2,2.69Mbps,用户家实测不卡;
//   ⚠️ 实时转发**零缓冲余量**——只能给 1x,网络一抖就卡,这是结构决定的);
// 线路2 139.227 txiptv(上海,1080p H.264+MP2 ~8.9Mbps,US 实测 1.9MB/s≈1.7x;7-01 死过一次会 flap);
// 线路3 `107.150.60.122/live/wxtyhd.m3u8` 跳转壳,302→192.187.115.106:82(每请求现签 jsbt/jsbk token,
//   电视自己跟 302;720p H.264 High + AAC,4.3Mbps,US 实测 10.6x 余量;10s 大分片起播慢几秒是结构性的。
//   ⚠️ 后端和 08-02 删掉的 38.75 是**同一台机器**(只是壳不同 from=zbdq6),版权时段大概率同样插「区域
//   限制」画面——用户 2026-08-12 知情拍板:当「非版权时段高清补充」用);
// 线路4 udpxy 组播中继 `58.35.63.158:4022` → 233.18.204.58(高清那一路,和死掉的 116.237 转同一路信号,
//   但又是**另一台盒子**,也不是线路1 那台;1080p H.264 High + MP2 ~8.4Mbps;原始播出信号永无区域限制,
//   但实时中继零余量,网络一抖就卡——和线路3 互补:一个怕网抖、一个怕版权时段);
// 线路5 kankan://10(火山,仅住宅固网,App端实时取token)。
//
// 2026-08-12 删掉 udpxy `116.237.161.27:8881` → 233.18.204.58(曾排线路3,08-02 加的):
//   整台盒子 TCP 连接超时(12s/30s 两次重测 + 状态页全不通),上线仅 10 天即整机离线。若日后复活可考虑加回。
//
// 2026-08-02 删掉 darwin 标清 `live.264788.xyz/channel/wuxingtiyu?streamid=574ea…`(曾排线路3):
//   源站 shcm-stream-cf1 从 2026-07-16 起 Cloudflare 522 一直没活,留守两周半没等到复活,
//   用户 TV 实测确认不能看。同账号的 darwin 高清线更早就删了。
//
// ⚠️ 2026-08-02 删掉 `38.75.136.137:98/gslb/dsdqpub/wxtyhd.m3u8?auth=testpub`(曾排线路3):
//   规格是这几条里最好的(真 1080p H.264 High + AAC,US 实测 2.4-2.6MB/s ≈ 4.7-5.1x 余量,
//   壳还会在多台后端间轮换),**但用户 TV 长期实测「很多时候显示无法播放,区域问题」**。
//   👉 教训:五星体育有大量版权节目会插「区域限制」画面,**服务端探测抓帧只能证明"某一刻在播真内容"**,
//      证明不了全天可用。这类频道必须以电视端长时间实测为准,不能靠一次抓帧下结论。
// 删:darwin 高清(2026-07-16 起源站 522 一直没活)、cdn15.163189/wxty(2026-07-06 确认 403)
const WX_PRIMARY = [
  { url: 'http://58.35.123.183:3333/rtp/233.18.204.6:5140', headers: {} },
  { url: 'http://139.227.21.22:9901/tsfile/live/1010_1.m3u8?key=txiptv', headers: {} },
  // 2026-08-12 用户给的新源,替换整机离线的 116.237 udpxy 盒子。跳转壳(每请求现签 token),
  // 抓帧确认真五星画面(壁球公开赛);720p H.264 High + AAC,4.3Mbps,US 10.6x 余量。
  // ⚠️ 后端 = 08-02 删的 38.75 同一台(192.187.115.106:82),版权时段会插区域限制画面,用户知情接受。
  { url: 'http://107.150.60.122/live/wxtyhd.m3u8', headers: {} },
  // 2026-08-12 用户给的新源。又一台 udpxy 盒子(不是线路1 那台,也不是死掉的 116.237),转组播 .58 高清。
  // 12s 收 12.6MB≈8.4Mbps 跑满码率,1080p H.264 High + MP2,抓帧真五星画面(《赛场》包装)。
  { url: 'http://58.35.63.158:4022/rtp/233.18.204.58:5140', headers: {} },
];
const WX_FALLBACKS = [];

// CCTV5 全显式 7 条线路(顺序即播放优先级,2026-07-01 重排:美国高清源置顶抗卡):
const C5_FALLBACKS = [
  // 1) 美国堪萨斯城 Nocix,302→198.204.233.138:82,720p,无 key/无 header —— 主力(US 实测 .ts 37Mbps≈11x 余量,std 1.6 真画面)
  { url: 'http://198.204.228.26/live/cctv5hd.m3u8', headers: {} },
  // 2) 美国堪萨斯城 WholeSale,302→173.208.146.10:8082,720p,无 key/无 header —— 主力(US 实测 .ts 25Mbps≈8x 余量,std 3.9 真画面)
  { url: 'http://bztv.tvbus.cc:8081/cdnlive/cctv5.m3u8', headers: {} },
  // 3) 咪咕视频壳(mg.cttv.vip→miguvideo 中国移动 CDN),HEVC 720p25+AAC ~1.5Mbps,无 UA/header 限制,壳每次现取 token 不过期。
  //    2026-07-01 曾 400 被删,07-01 晚复活且用户 VLC 实测全程流畅;US 办公网测 .ts 余量仅 1.3-1.8x(跨太平洋),但 CDN 独立(不与堪萨斯城机房群同生死),若再 400 降末尾或删
  { url: 'http://mg.cttv.vip/641886683', headers: {} },
  // 4) ysp 直连 2024078403 真 1080p;落沙特(43.152.31.17),.ts~7.4Mbps≈2.3x 余量,中东抖动次选
  { url: 'http://43.152.31.17:843/hlslive-tx-cdn.ysp.cctv.cn/ysp/2024078403_dlna.m3u8', headers: { Origin: SOURCE_B.ORIGIN } },
  // 5) ysp 直连 2024078401 540p;落沙特,.ts~4Mbps 低带宽兜底
  { url: 'http://43.152.31.17:843/hlslive-tx-cdn.ysp.cctv.cn/ysp/2024078401_dlna.m3u8', headers: { Origin: SOURCE_B.ORIGIN } },
  // 6) cqshushu php 壳 → 301→icntvcdn 未来电视 CDN(120.220.164.81 中国联通山东),1080p H.264 SAR1:1 真16:9;US 实测 .ts 2.7Mbps 余量 2.4x、首响 0.9-1.5s(2026-07-08 换掉过期的 cctv5-2:原 163189/cctv5-2 已 302→expired.html 死)
  { url: 'http://iptv.cqshushu.com/ysws.php?id=cctv5', headers: {} },
  // 7) 美国堪萨斯城 69.30 直连 1080p 无 key(原主线,2026-07-01 降末尾兜底)
  { url: 'http://69.30.245.50/live/cctv5.m3u8', headers: { Origin: SOURCE_B.ORIGIN } },
  // 8) ysp 540p 经 timetv 反代,低带宽末线兜底
  { url: 'https://timetv.shop/http://43.152.31.17:843/hlslive-tx-cdn.ysp.cctv.cn/ysp/2024078401_dlna.m3u8', headers: { Origin: SOURCE_B.ORIGIN } },
  // 9) udpxy 组播中继(上海电信,SD 720×576 ~2.8Mbps),独立故障域末位兜底;实时转发零余量+私人盒子,跨洋波动会卡(2026-07-06 US 测实时比 0.96x)。同盒 HD 版 233.18.204.71:5140 8Mbps 跨洋更易卡未用
  { url: 'http://58.35.123.183:3333/rtp/233.18.204.24:5140', headers: {} },
  // 删(2026-07-01):cdn16/cctv5(旧线路2)、darwin cctv5(livekey 账号级随时挂)
];

// CCTV5+ 全显式 4 条线路(顺序即播放优先级,2026-06-25 实测重排):
const C5P_FALLBACKS = [
  // 1) 163189 CF 前置 1080p,无 key,US/叔叔家友好(真 TS 伪装成 image/jpeg,魔数 0x47)—— 主力(2026-07-01 提为线路1,实测 1080p std59 5.4MB/s)
  { url: 'https://cdn16.163189.xyz/163189/cctv5p', headers: { Origin: SOURCE_B.ORIGIN } },
  // 2) 咪咕壳(mg.cttv.vip→miguvideo 中国移动 CDN),H.264 720p25+AAC,无 header/壳现取 token 不过期。独立 CDN 备份(2026-07-01 US 实测 ~1MB/s≈3x 余量;跨太平洋+会 flap)
  { url: 'http://mg.cttv.vip/641886773', headers: {} },
  // 3) 加拿大 720p(302→69.197.149.218)
  { url: 'http://207.56.13.146:81/cdnlive/cctv5p.m3u8', headers: { Origin: SOURCE_B.ORIGIN } },
  // 3) ysp 直连 540p(2024078001),低带宽末线兜底
  { url: 'http://43.152.31.17:843/hlslive-tx-cdn.ysp.cctv.cn/ysp/2024078001_dlna.m3u8', headers: { Origin: SOURCE_B.ORIGIN } },
  // 删:darwin cctv5p 1080p(2026-07-01 实测 livekey 账号级过期,主+备 key 全 error_account_expired.mp4)
];

const JISHI_EXTRA = [
  // 删:darwin dongfangweishi(2026-07-01 darwin livekey 账号级过期)
  // 1) 173.208 堪萨斯城 720p 直连
  { name: '东方卫视', url: 'http://173.208.212.130:8181/720p/dfws.m3u8', headers: {} },
  // 2) 咪咕壳(mg.cttv.vip→miguvideo 中国移动 CDN),HEVC 720p25+AAC,无 header/壳现取 token 不过期。独立 CDN 第二线(2026-07-01 US 实测 ~1.2MB/s≈3x 余量;跨太平洋+会 flap)
  { name: '东方卫视', url: 'http://mg.cttv.vip/651632648', headers: {} },
  // 纬来日本(Videoland Japan):rtmp 直推,f13h.mine.nu,720p H.264 Main 30fps+AAC。App 已集成 media3-datasource-rtmp(2026-07-17 加,US 实测 ffprobe 通)
  { name: '纬来日本', url: 'rtmp://f13h.mine.nu/sat/tv771', headers: {} },
];

// ---- static ----
// 2026-08-12(晚)凤凰中文换源:cdn6 的 fhzw/fhzx 是 1080p**50fps**(High L4.2+3B帧),
// 用户电视实测「声音正常、画面冻住」= 盒子解码扛不住 50fps(非网络非源死,同刘德华电影 FLV 硬解卡一类病)。
// 线1 = 港灣直播(everydaytv.top,收费服务的免费分享账号)壳名 jade 实际是凤凰中文,
//   后端 s15/t52.iptv200.com:8443/live/fhzw,720p **25fps** H.264 L3.1+AAC 仅~0.8Mbps,
//   2s 小分片起播快,US 实测 6x 余量,无 token/UA/Referer,和 163189 完全独立故障域。
//   ⚠️ 哈希子域名=账号 token,分享账号随时可能被回收,死了找用户要新分享链接。
// 线2 = 同 cdn6 后端的 fhhk(凤凰**香港**台,姊妹台节目基本相同),1080p 25fps,US 17x 余量,兜底。
// 旧 fhzw(50fps)直接删——冻屏的兜底没有意义。
// 凤凰资讯维持 fhzx(50fps,电视冻屏):08-12 海选全军覆没(详见 memory phoenix-infonews-source-hunt),
//   等用户从港灣直播同一来源找资讯台分享链接,或攒够重打包需求时做 YouTube extractor。
const STATIC_CHANNELS = [
  { alias: '凤凰中文', url: 'http://a68c7fdd1bed6600da71182507b4eab9.everydaytv.top/live/ggiptv/jade/playlist.m3u8' },
  { alias: '凤凰中文', url: 'https://cdn6.cc.cd/163189/fhhk' },
  { alias: '凤凰资讯', url: 'https://cdn6.cc.cd/163189/fhzx' },
];

// 体育组静态频道(非 yibababa,Cloudflare 前置,带 UA)
const STATIC_SPORTS = [
  { alias: 'ESPN', url: 'https://t.freetv.fun/live/espn.m3u8', headers: { 'User-Agent': SOURCE_A_HEADERS['User-Agent'] } },
  // 富士体育:美国 Buffalo host(HostPapa),真直播 5s 分片,用户实测可播
  { alias: '富士体育', url: 'https://fujitv4.mov3.co/hls/fujitv.m3u8', headers: {} },
];

// 「老陆子影院」轮播片单表。App 端 bili:// 解析器开台时拉这张表,按墙上时钟算出此刻该播哪部
// 哪一秒。表是静态的(片长不变),内容变了才需要重跑 build-catalog 重生成,不进 6h 刷新循环。
const LOOP_CATALOG = 'https://raw.githubusercontent.com/Warren-billionarie/LaoLuZi-TV/main/c.json';

// 电影组静态频道
const STATIC_MOVIES = [
  // 经典电影:咪咕跳转器(302→miguvideo H.264 ~2Mbps),每请求现签 token(存跳转器 URL,L2/L3 reload 自愈)。中国移动 host,US 实测 .ts 392KB/s≈1.5x 余量够播,随时段波动
  { alias: '经典电影', url: 'http://wfenf.x3322.net:7788/625703337', headers: { 'User-Agent': SOURCE_A_HEADERS['User-Agent'] } },
  // 动作电影(CHC动作,192.151.150.154):2026-07-25 按用户要求下线,位置让给「老陆子影院」
  // 周星驰电影:302→198.204.228.26 美国堪萨斯城 Nocix(zbdq 源站家族,同动作电影),US 实测 .ts 5.5MB/s 余量大
  { alias: '周星驰电影', url: 'http://198.204.228.26/live/lbzxc.m3u8', headers: {} },
  // 周润发电影:302→107.150.42.114:82(zbdq 源站家族,同周星驰/动作电影),480p H.264,US 实测首响 0.26s 真影片(2026-07-08 加)
  { alias: '周润发电影', url: 'http://107.150.60.122/live/lbzrf.m3u8', headers: {} },
  // 以下 5 条 2026-07-16 加:斗鱼/虎牙 24h 循环放剧直播间壳,壳每请求现签 token(302→FLV,存壳URL自愈),H.264+AAC FLV。US 办公室实测全通,CDN 无地域封锁
  // 冰冰影院:goodiptv 壳→hw3.douyucdn2.cn 斗鱼,720p,实测古装剧《洗冤录》
  { alias: '冰冰影院', url: 'http://www.goodiptv.club/douyu/74374', headers: { 'User-Agent': SOURCE_A_HEADERS['User-Agent'] } },
  // 刀刀影院:goodiptv 壳→hw1a.douyucdn2.cn 斗鱼,1080p,实测《水浒传》
  { alias: '刀刀影院', url: 'http://www.goodiptv.club/douyu/747764', headers: { 'User-Agent': SOURCE_A_HEADERS['User-Agent'] } },
  // 华语影院:goodiptv 壳→斗鱼(IP中转),1080p,实测《倚天屠龙记》
  { alias: '华语影院', url: 'http://www.goodiptv.club/douyu/3928', headers: { 'User-Agent': SOURCE_A_HEADERS['User-Agent'] } },
  // 古装武侠:goodiptv 壳→hw3.douyucdn2.cn 斗鱼,720p,实测《侠客行》
  { alias: '古装武侠', url: 'http://www.goodiptv.club/douyu/2793084', headers: { 'User-Agent': SOURCE_A_HEADERS['User-Agent'] } },
  // 刘德华电影(metshop 壳→虎牙 al.flv):2026-07-17 删除——直播FLV在电视盒子硬解+跨洋Wi-Fi下结构性卡顿(1080×602 非标准几何+B帧+时间戳不规整),VLC软解不卡,改源无解
  // 橙记港剧:goodiptv 壳→斗鱼,720p H.264 High 30fps+AAC ~4.2Mbps(2026-07-17 加,US 实测真FLV;码率偏高跨洋余量小)
  { alias: '橙记港剧', url: 'http://www.goodiptv.club/douyu/4549169', headers: { 'User-Agent': SOURCE_A_HEADERS['User-Agent'] } },
  // 热门港剧:goodiptv 壳→斗鱼,720p H.264 High 30fps+AAC ~3.1Mbps(2026-07-17 加,US 实测真FLV)
  { alias: '热门港剧', url: 'http://www.goodiptv.club/douyu/5522351', headers: { 'User-Agent': SOURCE_A_HEADERS['User-Agent'] } },
  // 七龙珠(metshop 壳→虎牙 11601966):2026-07-25 按用户要求下线
  //
  // ⚠️ 老陆子影院必须留在最后一条 —— LiveParser 的 txt 分支解析 `|Key=Value` 时,header map 是
  //    整个文件共享的、只在遇到 `#genre#` 时才清空,所以本行注入的 Referer 会「粘」到后面所有频道上。
  //    电影是最后一组、本条是组内最后一条 = 全文件最后一行,后面没有频道可被污染。加新台请加在本条之前。
  { alias: '老陆子影院', url: `bili://loop?src=${LOOP_CATALOG}`, headers: { 'Referer': 'https://www.bilibili.com' } },
];

// ============================================================

function md5(s) {
  return crypto.createHash('md5').update(s, 'utf8').digest('hex');
}

function hmacSha256(s, k) {
  return crypto.createHmac('sha256', k).update(s, 'utf8').digest('hex');
}

function aesDecryptCbc(b64Cipher, keyStr, ivStr) {
  const key = Buffer.from(keyStr, 'utf8');
  const iv = Buffer.from(ivStr, 'utf8');
  const cipher = Buffer.from(b64Cipher, 'base64');
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([decipher.update(cipher), decipher.final()]).toString('utf8');
}

function signA(userParams, apiVersion = 'v1') {
  const common = {
    platform: 'pc',
    version: SOURCE_A.VERSION,
    nonce: Math.random().toString(36).slice(-8),
    timestamp: Math.floor(Date.now() / 1000),
    'Api-Version': apiVersion,
  };
  const merged = { ...userParams, ...common };
  const sortedKeys = Object.keys(merged).sort();
  let qs = '';
  for (const k of sortedKeys) {
    if (merged[k] != null) qs += k + '=' + merged[k] + '&';
  }
  qs += SOURCE_A.SIGN_SALT;
  const sign = md5(md5(qs));
  return {
    'm-uuid': SOURCE_A.M_UUID,
    'timestamp': String(common.timestamp),
    'sign': sign,
    'nonce': common.nonce,
    'api-version': apiVersion,
    'version': common.version,
    'platform': common.platform,
    'referer': 'https://live.kankanews.com/',
    'origin': 'https://live.kankanews.com',
    'user-agent': SOURCE_A_HEADERS['User-Agent'],
    'accept': 'application/json, text/plain, */*',
  };
}

function decryptAddr(base64Cipher) {
  const cipherBytes = Buffer.from(base64Cipher, 'base64');
  let plain = '';
  for (let i = 0; i < cipherBytes.length; i += 128) {
    const block = cipherBytes.subarray(i, i + 128);
    if (block.length !== 128) continue;
    const decrypted = crypto.publicDecrypt(
      { key: SOURCE_A.PUB_KEY, padding: crypto.constants.RSA_PKCS1_PADDING },
      block,
    );
    plain += decrypted.toString('utf8');
  }
  return plain;
}

async function fetchA(channelId) {
  const url = `${SOURCE_A.API_BASE}/content/pc/tv/channel/detail?channel_id=${channelId}`;
  const headers = signA({ channel_id: channelId }, 'v1');
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${channelId}`);
  const data = await resp.json();
  if (data.code !== '1000') {
    throw new Error(`code=${data.code} message=${data.message} for ${channelId}`);
  }
  const cipher = data.result?.live_address;
  if (!cipher) throw new Error(`no payload for ${channelId}`);
  const m3u8 = decryptAddr(cipher);
  if (!m3u8.startsWith('http')) throw new Error(`bad payload (got: ${m3u8.slice(0, 50)})`);
  return m3u8;
}

async function probe(url, originHeader) {
  try {
    const resp = await fetch(url, {
      headers: {
        Origin: originHeader,
        'User-Agent': SOURCE_A_HEADERS['User-Agent'],
        'Accept': 'application/vnd.apple.mpegurl,*/*',
      },
      signal: AbortSignal.timeout(4000),
    });
    if (!resp.ok) return false;
    const body = await resp.text();
    return body.startsWith('#EXTM3U') && body.includes('#EXTINF');
  } catch {
    return false;
  }
}

// 剥掉 yibababa 的播放器壳,拿到真实可播 URL:
//   https://www.yibababa.com/player/tcplayer/?url=<real>  → <real>
//   https://cors-proxy.cooks.fyi/<real>                   → <real>
// 两层可能叠加(player 壳里再套 cors-proxy),顺序剥。裸 URL 原样返回。
function unwrap(u) {
  const m = u.match(/[?&]url=(.+)$/);
  if (m) u = decodeURIComponent(m[1]);
  u = u.replace(/^https?:\/\/cors-proxy\.cooks\.fyi\//i, '');
  return u;
}

async function pickMulti(allLines, wanted) {
  const prepend = wanted.prepend || [];
  const candidates = [...prepend];
  for (const line of allLines) {
    if (!wanted.match.test(line)) continue;
    const commaIdx = line.indexOf(',');
    if (commaIdx < 0) continue;
    candidates.push(unwrap(line.slice(commaIdx + 1).trim()));
  }
  // 去重:剥壳后不同壳可能指向同一真 URL(如 line4 cors-proxy 包的 69.30 == prepend)
  const seen = new Set();
  const uniq = candidates.filter(u => (seen.has(u) ? false : (seen.add(u), true)));
  if (uniq.length === 0) return [];

  uniq.sort((a, b) => {
    const aPre = prepend.includes(a) ? 0 : 2;
    const bPre = prepend.includes(b) ? 0 : 2;
    if (aPre !== bPre) return aPre - bPre;
    const aPref = wanted.preferContains && a.includes(wanted.preferContains) ? 0 : 1;
    const bPref = wanted.preferContains && b.includes(wanted.preferContains) ? 0 : 1;
    return aPref - bPref;
  });

  const probed = await Promise.all(
    uniq.map(async u => ({ url: u, alive: await probe(u, SOURCE_B.ORIGIN) }))
  );

  const alive = probed.filter(r => r.alive).map(r => r.url);
  const dead = probed.filter(r => !r.alive).map(r => r.url);
  const picked = alive.slice(0, wanted.maxLines);
  if (picked.length < wanted.maxLines) {
    picked.push(...dead.slice(0, wanted.maxLines - picked.length));
  }

  for (const u of picked) {
    const ok = alive.includes(u);
    console.error(`[${wanted.alias}] ${ok ? 'ok  ' : 'dead'} ${u.slice(0, 90)}`);
  }
  return picked.map(url => ({ alias: wanted.alias, url, headers: wanted.headers || {} }));
}

async function fetchBFeed(name) {
  const resp = await fetch(SOURCE_B.FEEDS[name], {
    headers: {
      'User-Agent': SOURCE_A_HEADERS['User-Agent'],
      'Accept': 'text/plain,*/*;q=0.9',
    },
  });
  if (!resp.ok) throw new Error(`B feed ${name} HTTP ${resp.status}`);
  return (await resp.text()).split(/\r?\n/);
}

async function fetchB() {
  // 每个 feed 只拉一次;单个 feed 挂掉不连累其他频道(返回空行,multi 频道仍能用 prepend)
  const feedCache = {};
  async function getFeed(name) {
    if (name in feedCache) return feedCache[name];
    try {
      feedCache[name] = await fetchBFeed(name);
    } catch (e) {
      console.error(`[warn] B feed ${name} failed: ${e.message}`);
      feedCache[name] = [];
    }
    return feedCache[name];
  }

  const out = [];
  for (const wanted of SOURCE_B_WANTED) {
    const lines = await getFeed(wanted.feed);
    if (wanted.multi) {
      const picked = await pickMulti(lines, wanted);
      if (picked.length === 0) console.error(`[warn] no match for ${wanted.alias}`);
      out.push(...picked);
      continue;
    }
    const hit = lines.find(l => wanted.match.test(l));
    if (!hit) {
      console.error(`[warn] no match for ${wanted.alias}`);
      continue;
    }
    const commaIdx = hit.indexOf(',');
    if (commaIdx < 0) continue;
    const url = unwrap(hit.slice(commaIdx + 1).trim());
    out.push({ alias: wanted.alias, url, headers: wanted.headers || {} });
  }
  return out;
}

async function fetchC(articleId) {
  const tt = Date.now().toString();
  const t = tt.substr(0, 10);
  const sail = md5(`articleId=${articleId}&scene_type=${SOURCE_C.SCENE_TYPE}`);
  const w = `&&&${SOURCE_C.APP_KEY}&${sail}&${t}&emas.feed.article.live.detail&1.0.0&&&&&`;
  const sign = hmacSha256(w, SOURCE_C.HMAC_KEY);
  const clientId = md5(t);
  const url = `${SOURCE_C.API_BASE}?articleId=${articleId}&scene_type=${SOURCE_C.SCENE_TYPE}`;

  const resp = await fetch(url, {
    headers: {
      cookieuid: clientId,
      'from-client': 'h5',
      'x-emas-gw-appkey': SOURCE_C.APP_KEY,
      'x-emas-gw-pv': '6.1',
      'x-emas-gw-sign': sign,
      'x-emas-gw-t': t,
      'x-req-ts': tt,
      'Referer': 'https://www.nettv.live/',
      'User-Agent': SOURCE_A_HEADERS['User-Agent'],
    },
    signal: AbortSignal.timeout(SOURCE_C.TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`C HTTP ${resp.status}`);
  const outer = await resp.json();
  if (!outer.response) throw new Error(`C: missing response`);
  const inner = JSON.parse(Buffer.from(outer.response, 'base64').toString('utf8'));
  const data = inner.data;
  if (!data || !data.dk) throw new Error(`C: missing dk`);

  const dk = data.dk.toString();
  const key = dk.substr(0, 8) + t.substr(-8);
  const iv = dk.substr(-8) + t.substr(0, 8);

  const cam = data.live_room && data.live_room.liveCameraList && data.live_room.liveCameraList[0];
  if (!cam) throw new Error(`C: missing cam`);
  const ar = cam.pullUrlList && cam.pullUrlList[0] && cam.pullUrlList[0].authResultUrl && cam.pullUrlList[0].authResultUrl[0];
  if (!ar || !ar.authUrl) throw new Error(`C: missing authUrl`);

  const urls = [aesDecryptCbc(ar.authUrl, key, iv)];
  if (Array.isArray(ar.demote_urls)) {
    for (const d of ar.demote_urls) {
      if (d && d.authUrl) urls.push(aesDecryptCbc(d.authUrl, key, iv));
    }
  }
  return urls.filter(u => u && u.startsWith('http'));
}

function suffix(headers) {
  return '|' + Object.entries(headers).map(([k, v]) => `${k}=${v}`).join('&');
}

function build({ aResults, bResults, bExtra, c9Lines, c13Lines, statics }) {
  const aSuffix = suffix(SOURCE_A_HEADERS);
  const bSuffix = suffix({ Origin: SOURCE_B.ORIGIN });

  const lines = [];

  lines.push('体育,#genre#');
  for (const fb of WX_PRIMARY) {
    const s = fb.headers && Object.keys(fb.headers).length > 0 ? suffix(fb.headers) : '';
    lines.push(`五星体育,${fb.url}${s}`);
  }
  for (const ch of aResults.filter(c => (c.group || '体育') === '体育')) lines.push(`${ch.name},${ch.url}${aSuffix}`);
  for (const fb of WX_FALLBACKS) {
    const s = fb.headers && Object.keys(fb.headers).length > 0 ? suffix(fb.headers) : '';
    lines.push(`五星体育,${fb.url}${s}`);
  }
  for (const ch of bResults.filter(c => c.alias === 'CCTV5')) {
    const s = ch.headers && Object.keys(ch.headers).length > 0 ? suffix(ch.headers) : '';
    lines.push(`${ch.alias},${ch.url}${s}`);
  }
  for (const fb of C5_FALLBACKS) {
    const s = fb.headers && Object.keys(fb.headers).length > 0 ? suffix(fb.headers) : '';
    lines.push(`CCTV5,${fb.url}${s}`);
  }
  for (const fb of C5P_FALLBACKS) {
    const s = fb.headers && Object.keys(fb.headers).length > 0 ? suffix(fb.headers) : '';
    lines.push(`CCTV5+,${fb.url}${s}`);
  }
  for (const ch of bResults.filter(c => c.alias === 'CCTV5+')) {
    const s = ch.headers && Object.keys(ch.headers).length > 0 ? suffix(ch.headers) : '';
    lines.push(`${ch.alias},${ch.url}${s}`);
  }
  for (const ch of bResults.filter(c => c.alias !== 'CCTV5' && c.alias !== 'CCTV5+')) {
    const s = ch.headers && Object.keys(ch.headers).length > 0 ? suffix(ch.headers) : '';
    lines.push(`${ch.alias},${ch.url}${s}`);
  }
  for (const ch of STATIC_SPORTS) {
    const s = ch.headers && Object.keys(ch.headers).length > 0 ? suffix(ch.headers) : '';
    lines.push(`${ch.alias},${ch.url}${s}`);
  }

  lines.push('央视,#genre#');
  for (const ch of bExtra) lines.push(`${ch.alias},${ch.url}${bSuffix}`);
  for (const ch of c9Lines) {
    const s = ch.headers && Object.keys(ch.headers).length > 0 ? suffix(ch.headers) : '';
    lines.push(`${ch.alias},${ch.url}${s}`);
  }
  for (const ch of c13Lines) {
    const s = ch.headers && Object.keys(ch.headers).length > 0 ? suffix(ch.headers) : '';
    lines.push(`${ch.alias},${ch.url}${s}`);
  }
  for (const ch of statics.filter(c => c.alias.startsWith('CCTV'))) lines.push(`${ch.alias},${ch.url}`);

  lines.push('港澳台,#genre#');
  for (const ch of statics.filter(c => c.alias.startsWith('凤凰'))) lines.push(`${ch.alias},${ch.url}`);

  const jishi = aResults.filter(c => (c.group || '体育') === '纪实');
  if (jishi.length || JISHI_EXTRA.length) {
    lines.push('纪实,#genre#');
    for (const ch of jishi) lines.push(`${ch.name},${ch.url}${aSuffix}`);
    for (const ch of JISHI_EXTRA) {
      const s = ch.headers && Object.keys(ch.headers).length > 0 ? suffix(ch.headers) : '';
      lines.push(`${ch.name},${ch.url}${s}`);
    }
  }

  if (STATIC_MOVIES.length) {
    lines.push('电影,#genre#');
    for (const ch of STATIC_MOVIES) {
      const s = ch.headers && Object.keys(ch.headers).length > 0 ? suffix(ch.headers) : '';
      lines.push(`${ch.alias},${ch.url}${s}`);
    }
  }

  return lines.join('\n') + '\n';
}

async function main() {
  console.error('[info] A...');
  // token 现由 App 端 kankan:// extractor 在播放设备上实时获取(火山 CDN 按 token 内
  // user_ip 放行,runner IP 取的 token 电视用不了 → 403),这里只输出静态 kankan://<id> 入口。
  const aResults = [];
  for (const ch of SOURCE_A_CHANNELS) {
    aResults.push({ name: ch.name, url: 'kankan://' + ch.id, group: ch.group || '体育' });
    console.error(`[ok] ${ch.name}: kankan://${ch.id}`);
  }

  console.error('[info] B...');
  let bResults = [];
  try {
    bResults = await fetchB();
    for (const ch of bResults) console.error(`[ok] ${ch.alias}: ${ch.url.slice(0, 80)}...`);
  } catch (e) {
    console.error(`[fail] B: ${e.message}`);
  }

  const bExtra = SOURCE_B_EXTRA;
  const statics = STATIC_CHANNELS;
  for (const ch of bExtra) console.error(`[static] ${ch.alias}`);
  for (const ch of statics) console.error(`[static] ${ch.alias}`);

  console.error('[info] C...');
  const c9Lines = [];
  for (const cfg of SOURCE_C_CHANNELS) {
    try {
      const urls = await fetchC(cfg.articleId);
      for (const u of urls.slice(0, cfg.maxLines)) {
        console.error(`[ok] ${cfg.alias} (C): ${u.slice(0, 90)}...`);
        c9Lines.push({ alias: cfg.alias, url: u, headers: {} });
      }
    } catch (e) {
      console.error(`[fail] C ${cfg.alias}: ${e.message}`);
    }
  }
  for (const fb of C9_FALLBACKS) {
    c9Lines.push({ alias: 'CCTV9', url: fb.url, headers: fb.headers });
    console.error(`[static] CCTV9 fallback: ${fb.url.slice(0, 90)}...`);
  }

  const c13Lines = [];
  for (const fb of C13_FALLBACKS) {
    c13Lines.push({ alias: 'CCTV13', url: fb.url, headers: fb.headers });
    console.error(`[static] CCTV13 fallback: ${fb.url.slice(0, 90)}...`);
  }

  const totalDynamic = aResults.length + bResults.length;
  if (totalDynamic === 0) {
    console.error('[fatal] no dynamic channels resolved, aborting');
    process.exit(2);
  }

  const txt = build({ aResults, bResults, bExtra, c9Lines, c13Lines, statics });

  const outArg = process.argv.find(a => a.startsWith('--out='));
  if (outArg) {
    const path = outArg.slice('--out='.length);
    fs.writeFileSync(path, txt, 'utf8');
    console.error(`[info] wrote ${txt.length} bytes to ${path}`);
  } else {
    process.stdout.write(txt);
  }
}

main().catch(e => {
  console.error('[fatal]', e);
  process.exit(1);
});
