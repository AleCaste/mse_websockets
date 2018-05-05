'use strict';
(function(){

  // ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  /* 
     msePlayer
     ==========
     processOptions(options)
     constructor(options)
     init(options)
       _initPlayVideoChunksOverHttp()
     _downloadSegment(url, cb, aux)
     reset(cb)
       _resetMs(cb)
     _mseAddTrack(track)
     _sbUpdateend(msePlayer, isInit, isEndOfAppend, e)
     _sbOnUpdateend(msePlayer, isInit, isEndOfAppend, e)
     _sbOnUpdateendFirstOne(msePlayer, e)
  */
  var MsePlayer = function(options) {
    var t = this;
    t.constructor(options);
    return t;
  };
  {
    // ----------------------------------------------------------------------------
    // This method is used to get a set of options and process them (assigning defaults if need be, etc)
    // The options object is the one accepted by both the 'constructor' and the 'init' methods.
    // The properties it can handle can be seen here below:
    MsePlayer.prototype.processOptions = function(options) {
      var t = this, d = t.d;
      if (options==null)  options = {};
        if (options.video==null)  { if (d.video==void(0)) { options.video = document.getElementById('video_player'); } else { delete options.video; }}
        if (options.src==null)    { if (d.src==void(0))   { options.src = null; } else { delete options.src; }}
        
      // If an html5 media video DOM elem has been specified, let's bind the eventListeners we need
      if (options.video!=null) {
        var video = options.video;
        video.addEventListener('error', function(e) {
          console.error('[MediaSourceExtension] - Error:', e);
        });
        video.addEventListener('timeupdate', function(e) {
          // If the playback has reached the end of the current stream duration, we close the stream (for live streams we should never do this)
          //console.info('[VideoTag] - timeupdate - currentTime:['+video.currentTime+']  duration:['+(d.mse && d.mse.duration)+']');
          if (d.mse && d.mse.readyState==='open' && d.mse.duration-video.currentTime<1)  {
            console.info('[MediaSourceExtension] - Ending stream');
            d.mse.endOfStream();
          }
        });
        //video.addEventListener('seeking', function(e) {
        //});
        //video.addEventListener('loadedmetadata', function(e) {
        //  this.currentTime = 13;
        //});
      }        
        
      return options;
    };
    // ----------------------------------------------------------------------------    
    MsePlayer.prototype.constructor = function(options) {
      var t = this;

      // Instance data map (d stands for Data):
      // ======================================
      t.d = {
        // It will have all the properties included in 'options' here, plus:
        feedingMechanism: null,  // http | websockets
        video: null,             // The <video> tag DOM elem
        mse: null                // The MediaSource instance (with added custom props like:  startTime, pendingSbsInitialSegmentsToAppend)
      };

      // We process the passed options and store them in the data map (t.d)
      // NOTE: we do NOT call t.init(options) here as the init method is supposed to execute additional code in the future.
      options = t.processOptions(options);    
      Object.assign(t.d, options);  
    };
    // ----------------------------------------------------------------------------
    // This method inits the video downloading (and the playback of the stream if autoplay is on)
    MsePlayer.prototype.init = function(options) {
      var t = this, d = t.d;
      options = t.processOptions(options);
      Object.assign(t.d, options);
      
      // Start video playback based on the specified src
      if (d.src==null)  return;
      if (d.src.match(/^wss?:\/\//)!=null) {
        // Websocket-based video stream
        d.feedingMechanism = 'websockets';
        //t._initPlayVideoChunksOverWebsockets();
      } else {
        // Video file
        d.feedingMechanism = 'http';
        t._initPlayVideoChunksOverHttp();
      }
    };
    // ----------------------------------------------------------------------------
    // This is a private method called by 'init' when the video comes from http segments
    // The sets the tracks used by MediaSource (creating one SourceBuffer object per track)
    // and once this is done, it starts downloading the segments in intervals of N milliseconds
    // (both the number of segments to download and this download interval is hard-coded for this demo)
    // (in a production env the player could receive a info frame which could specify these details)
    MsePlayer.prototype._initPlayVideoChunksOverHttp = function() {
      var t = this, d = t.d;
      var video = d.video;
      
      t.reset(function(err, data) {
        if (err!=null)  return;
        
        // Create a SourceBuffer per track and add it to the MediaSource instance
        // The 'track' arg is an object with the following props: { id, codec, kind, type, language, name }
        var mse = d.mse,
            sbs = [],
            track,
            tracksToPlay = [],
            initializationSegmentToBeRetrieved,
            iSegmentFirst, iSegmentLast, iSegmentDownloadFrom, iSegmentDownloadTo, iSegmentDownload;
        
        // Let's add the video/audio tracks (we are NOT reading a DASH .mpd file so these details are hard-coded in the options object passed to the msePlayer constructor)
        d.tracks.map(function(track) {
          var sb = t._mseAddTrack(track); // This creates a new SourceBuffer (with necessary events bindings) and returns it
          sbs.push(sb);  // Note that the MediaSource object also keeps all the sbs in its .sourceBuffers property (but this prop is an object)
          tracksToPlay.push(track);
        });

        // If different iSegmentFirst/iSegmentLast values have been specified per track, let's determine the overall iSegmentFirst/iSegmentLast
        tracksToPlay.map(function(track){ 
          if (track.iSegmentFirst!=null && (iSegmentFirst==null || track.iSegmentFirst<iSegmentFirst))  iSegmentFirst = track.iSegmentFirst;
          if (track.iSegmentLast!=null  && (iSegmentLast==null  || track.iSegmentLast>iSegmentLast))    iSegmentLast  = track.iSegmentLast;
        });
        
        // Define starting segment to start downloading for all tracks
        iSegmentDownloadFrom = d.iSegmentDownloadFrom;
          if (iSegmentDownloadFrom==null || iSegmentDownloadFrom<iSegmentFirst)  iSegmentDownloadFrom = iSegmentFirst;
        iSegmentDownloadTo = iSegmentLast;
        
        // Start downloading the segments!!
        if (iSegmentDownloadFrom!=null && iSegmentDownloadTo!=null) {
          iSegmentDownload = iSegmentDownloadFrom;
          initializationSegmentToBeRetrieved = true
          mse.pendingSbsInitialSegmentsToAppend = tracksToPlay.length;
          var downloadChunk = function(iSegmentDownload) {
            // Segments generated through command:  MP4Box -dash 2000 -bound -profile dashavc264:live -segment-name XXXXXX.dash.$RepresentationID$.$Number$ XXXXXX.mp4#video XXXXXX.mp4#audio
            // 2000/(1/30 * 1000) = 60 frames (of 1/30 * 1000 = 33.3333ms each frame)
            // 2000ms = 1.332s of video per segment
            sbs.map(function(sb, i) {
              if (sb.track.iSegmentLast!=null && iSegmentDownload>sb.track.iSegmentLast)  return;
              var url;
              // Should we retrieve the initialization segment or the proper data segments?
              // We ALWAYS need to retrieve the initialization segment first!
              if (true && initializationSegmentToBeRetrieved==true)  url = `${d.src}.dash.${sb.track.id}..mp4`;
              else                                                   url = `${d.src}.dash.${sb.track.id}.${iSegmentDownload}.m4s`;
              // Now let's download the segment:
              t._downloadSegment(url, function(err, data, aux) {
                //console.log('  New data received through http...   length:'+data.byteLength+'   type:'+Object.prototype.toString.call(data)+'   url:'+aux.url);
                if (err!=null)  return;
                var sb = aux.sb;
                var trackId = sb.track.id;
                sb.segmentSequenceNumber++;
                sb.pendingSbSegmentsToAppend.push({ trackId:trackId, buffer:data });
                console.info('[Track#'+trackId+'] - Received new segment. Number of segments remaining still to be appended:['+sb.pendingSbSegmentsToAppend.length+']');
                sb.updateend(false, false);
              }, {sb:sb, url:url});
            });
            if (initializationSegmentToBeRetrieved==true) initializationSegmentToBeRetrieved = false;
            else                                          iSegmentDownload++;
            if (iSegmentDownload<=iSegmentDownloadTo) {
              // Let's schedule the download of the next segment:
              setTimeout(function() {
                downloadChunk(iSegmentDownload);
              }, d.segmentsDurationMs * 0.7);  // 70% of the nominal average segment duration used (we need to request the segments download a bit faster that the duration of them)
            }
          };
          downloadChunk(iSegmentDownload);
        }
        
      });
    }
    // ----------------------------------------------------------------------------
    // This method uses xhr to download a media segment associated to a track.
    // Once it has finished the download, it calls the callback arg 'cb' with the buffer data.
    // 'aux' is an auxiliary object that may contain some properties passed from the caller that are associated to the segment (like the sb object).
    // This aux object is passed back to the caller through the cb call.
    MsePlayer.prototype._downloadSegment = function(url, cb, aux) {
      var t = this, d = t.d;
      var xhr = new XMLHttpRequest;
      
      xhr.open('get', url);
      xhr.responseType = 'arraybuffer';
      xhr.onload = function() {
        cb(null, xhr.response, aux);
      };
      xhr.send();
    };
    // ----------------------------------------------------------------------------
    // This function resets all the components used by the player
    MsePlayer.prototype.reset = function(cb) {
      var t = this, d = t.d;
      
      var ncbsLocal = 0, cbLocalData = [];
      var cbLocal = function(err, data) {
        if (ncbsLocal==null) return;
        ncbsLocal++; cbLocalData.push(data);
        if (err!=null)          { ncbsLocal = null; cb && cb(err, null); }
        else if (ncbsLocal>=1)  { cb && cb(err, cbLocalData); }
      }
      
      t._resetMs(cbLocal);
    };
    // ----------------------------------------------------------------------------
    // This is a private method called within the 'reset' method that resets the MediaSource instance
    MsePlayer.prototype._resetMs = function(cb) {
      var t = this, d = t.d;
      var video = d.video;
      var mse = d.mse;

      d.mse = null;
      
      mse = new MediaSource();
        mse.addEventListener('sourceopen', function(e) {
          var mse = e.target;
          console.info('[MediaSourceExtension] - Source opened');
          //console.debug('[MediaSourceExtension] - Details:', mse);
          cb && cb();
        });
        mse.addEventListener('sourceclose', function(e) {
          var mse = e.target;
          if (mse.video.error) {
            console.error('[MediaSourceExtension] - Source closed, video error:'+mse.video.error.code);
          } else {
            console.info('[MediaSourceExtension] - Source closed, no error');
          }
        });

      mse.video = video;
      video.src = window.URL.createObjectURL(mse);

      /* TODO: cannot remove Text tracks! Turning them off for now*/
      for (var i = 0; i < video.textTracks.length; i++) {
        var tt = video.textTracks[i];
        tt.mode = 'disabled';
      }
      
      d.mse = mse;
    };
    // ----------------------------------------------------------------------------
    // Creates a SourceBuffer per track and adds it to the MediaSource instance
    // The 'track' arg is an object with the following props: { id, codec, type, kind, language, name }
    MsePlayer.prototype._mseAddTrack = function(track) {
      var t = this, d = t.d;
      var mse = d.mse;
      var video = d.video;
      var sb;
      var trackId = track.id;
      var codec = track.codec;
      var mime = track.type+'/mp4; codecs=\"'+codec+'\"';
      var kind = track.kind;
      var trackDefault;
      var trackDefaultSupported = (window.TrackDefault!==void(0));
      var html5TrackKind = '';
      
      // Get html5TrackKind
      if (codec == 'wvtt') {
        if (!kind.schemeURI.startsWith('urn:gpac:')) {
          html5TrackKind = 'subtitles';
        } else {
          html5TrackKind = 'metadata';
        }
      } else {
        if (kind && kind.schemeURI==='urn:w3c:html5:kind') {
          html5TrackKind = kind.value || '';
        } 
      }
      
      // Create TrackDefault instance
      if (trackDefaultSupported) {
        if (track.type==='video' || track.type==='audio') {
          trackDefault = new TrackDefault(track.type, track.language, track.name, [ html5TrackKind ], trackId);
        } else {
          trackDefault = new TrackDefault('text', track.language, track.name, [ html5TrackKind ], trackId);
        }
      }
      
      // Create SourceBuffer for this track and attach it to the MediaSource instance
      if (MediaSource.isTypeSupported(mime)) {
        try {
          console.info('[Track#'+trackId+'] - Created new SourceBuffer with media type:['+mime+']');
          
          /*  Each sb (SourceBuffer) object will have the following structure:
              ----------------------------------------------------------------
              sb
                <SourceBuffer> properties
                mse                 // This is the MediaSource the SourceBuffer is attached to
                track               // Our custom track object with props like id, codec, etc
                trackDefaults
                startTime           // Initially null. Once we receive the 1st segment with time information, this prop is updated with the startTime of the segment
                segmentSequenceNumber
                pendingSbSegmentsToAppend[]
                  trackId
                  buffer
                buffered
                updating
                <Events>
                  updateend          
                  error
                <Event handlers>
                  onUpdateendFirstOne
                  onUpdateend
          */
          sb = mse.addSourceBuffer(mime);
            sb.mse = mse;
            sb.track = track;
            sb.trackDefaults = null;
              if (trackDefaultSupported) {
                sb.trackDefaults = new TrackDefaultList([trackDefault]);
              }
            sb.addEventListener('error', function(e) {
              console.error('MSE SourceBuffer #'+trackId, e);
            });

            sb.segmentSequenceNumber = 0;
            sb.pendingSbSegmentsToAppend = [];
          
            sb.updateend           = t._sbUpdateend.bind(sb, t);
            sb.onUpdateend         = t._sbOnUpdateend.bind(sb, t, false, true);
            sb.onUpdateendFirstOne = t._sbOnUpdateendFirstOne.bind(sb, t);

            sb.addEventListener('updateend', sb.onUpdateendFirstOne);
            
        } catch (e) {
          console.error('MSE - SourceBuffer #'+trackId,'Cannot create buffer with type ['+mime+']' + e);
        }
      } else {
        console.warn('MSE', 'MIME type ['+mime+'] not supported for creation of a SourceBuffer for track id '+trackId);
      }
      
      return sb;
    };
    // ----------------------------------------------------------------------------
    // Handler function for the 'updateend' event of a sb (SourceBuffer) instance.
    // This where the received buffer data is appended to the sb.
    // It also check if the received buffer has time start-end information because if it does and we have received segments from all tracks, then
    // we can set the video.currentTime to the apropriate position (in live streams we don't play from the begining)
    MsePlayer.prototype._sbUpdateend = function(msePlayer, isInit, isEndOfAppend, e) {
      var sb = this;    // equals to e.target
      var mse = sb.mse; // equals to msePlayer.d.mse
      //if (window.s!=null && window.s>15)  debugger;
      var video = msePlayer.d.video;
        //if (video.paused==true)  video.play();
      if (isEndOfAppend===true) {
        if (isInit!==true) {
        }
      }
      if (mse.readyState==='open' && sb.updating===false && sb.pendingSbSegmentsToAppend.length>0) {
        var pendingSbSegmentToAppend = sb.pendingSbSegmentsToAppend.shift();
        console.info('[Track#'+sb.track.id+'] - Appended segment. Number of segments remaining still to be appended:['+sb.pendingSbSegmentsToAppend.length+']');
        sb.appendBuffer(pendingSbSegmentToAppend.buffer);
        
        // Now let's check if the buffer contains time details about the start-end times the segment is associated to.
        for (var i=0; i<sb.buffered.length; ++i) {
          var startTime = sb.buffered.start(i);
          var endTime = sb.buffered.end(i);
          //console.log('track:'+sb.track.id, startTime, endTime, video.paused, mse.video.currentTime, mse.duration);
          
          // The media startTime is initially set to null.
          // But as we receive segments from all the tracks associated to the media, we save their startTimes (one per track)
          // and after we have received startTimes from all tracks, we can set the overall startTime for the media.
          // Once we have that we can move the video.currentTime to that position.
          if (startTime!=null && sb.startTime==null)  {
            sb.startTime = startTime;
            if (mse.startTime==null && mse.sourceBuffers) {
              for(var key in mse.sourceBuffers) {
                if (mse.sourceBuffers.hasOwnProperty(key)==true) {
                  var _sb = mse.sourceBuffers[key];
                  if (_sb.startTime==null)  { mse.startTime = null; break; }
                  if (mse.startTime==null || _sb.startTime>mse.startTime)  mse.startTime = _sb.startTime;
                }
              };
              if (mse.startTime!=null) {
                console.info('[VideoTag] - Setting start playback time to:['+mse.startTime+']  duration:['+mse.duration+']');
                mse.video.currentTime = mse.startTime;
                mse.video.play();  // Chrome ignores autoplay+muted and also ignores this command. On Firefox it works ok
                //mse.duration = Infinity;                
              }
            }
          }
        }        
        
      }
    };
    // ----------------------------------------------------------------------------
    MsePlayer.prototype._sbOnUpdateend = function(msePlayer, isInit, isEndOfAppend, e) {
      var sb = this;  // equals to e.target
      return msePlayer._sbUpdateend.call(sb, msePlayer, isInit, isEndOfAppend, e);
    };
    // ----------------------------------------------------------------------------
    // Handler function for the first 'updateend' event of a sb (SourceBuffer) instance.
    MsePlayer.prototype._sbOnUpdateendFirstOne = function(msePlayer, e) {
      var sb = this;  // equals to e.target
      if (sb.mse.readyState==='open') {
        sb.removeEventListener('updateend', sb.onUpdateendFirstOne);
        sb.addEventListener('updateend', sb.onUpdateend);
        // In case there are already pending buffers we call onUpdateEnd to start appending them
        sb.updateend(true, true);
        sb.mse.pendingSbsInitialSegmentsToAppend--;
        if (sb.mse.pendingSbsInitialSegmentsToAppend===0 && msePlayer.d.feedingMechanism=='http')  {
          // Al initialization segments (one per track) have been appended!
        }
        
      }
    };
    // ----------------------------------------------------------------------------    
    // End of MsePlayer
  }
  // ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~



  
  
  
  // Ready to go!!!
  // Let's create a new instance of a MsePlayer and init it with the right parameters for the requested stream
  var getQueryStringParameterByName = function(name, url) {
      if (!url) url = window.location.href;
      name = name.replace(/[\[\]]/g, "\\$&");
      var regex = new RegExp("[?&]" + name + "(=([^&#]*)|&|#|$)"),
          results = regex.exec(url);
      if (!results) return null;
      if (!results[2]) return '';
      return decodeURIComponent(results[2].replace(/\+/g, " "));
  };
  var options = {
    // We pass the DOM elem with the <video> tag we want the player to use
    video: document.getElementById('video_player'),
    
    // We specify the source of the media (the media will be downloaded in segments that have been pre-generated at the server side by the MP4Box tool)
    src: '/media/',  // Base folder where our media files are stored
      
    // Let's specify the video/audio tracks to play and their details.
    // (We are NOT reading a DASH .mpd file so these details are hard-coded here. In a production env the player should receive an info frame which could specify these details)
    tracks: [],    
    
    // The following prop is the approx average duration of the segments. It should be the same value as the one in the -dash arg used by MP4Box when the dash segments where generated at the server side
    // Segments generated through command:  MP4Box -dash 2000 -bound -profile dashavc264:live -segment-name XXXXXX.dash.$RepresentationID$.$Number$ XXXXXX.mp4#video XXXXXX.mp4#audio
    segmentsDurationMs: 2000,
    
    // NOTE: you may specify (as we have!) which initial segment you want to receive.
    // For test purposes, in our case we want to start playback from the middle of the stream approx (simulating that the stream was alreade running when the player connected to it)
    // so iSegmentDownloadFrom=4 considering the total of segments for both video/video
    iSegmentDownloadFrom: 4  
  };
  var stream_id = parseInt(getQueryStringParameterByName('id')); if (isNaN(stream_id)==true)  stream_id = null;
  switch (stream_id) {
    case 52:
      options.src += 'bunny_720x480';
      options.tracks.push({id:1, codec:'avc3.4D401E', type:'video', kind:{schemeURI:'', value:''}, language:'und', name:'L-SMASH Video Handler', iSegmentFirst:1, iSegmentLast:8});
      options.tracks.push({id:2, codec:'mp4a.40.2',   type:'audio', kind:{schemeURI:'', value:''}, language:'und', name:'L-SMASH Audio Handler', iSegmentFirst:1, iSegmentLast:16});
      break;
    case 37:
    default:
      if (stream_id==null)  stream_id = 37;
      options.src += 'tears_of_steel_1280x534';
      options.tracks.push({id:1, codec:'avc3.64001F', type:'video', kind:{schemeURI:'', value:''}, language:'und', name:'L-SMASH Video Handler', iSegmentFirst:1, iSegmentLast:11});
      options.tracks.push({id:2, codec:'mp4a.40.2',   type:'audio', kind:{schemeURI:'', value:''}, language:'und', name:'L-SMASH Audio Handler', iSegmentFirst:1, iSegmentLast:11});
      break;
  }
  // Create an mse player instance and init it!
  window.msePlayer = new MsePlayer(options);
  window.msePlayer.init();
  
})();



