(function(){

  // ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  /* 
     mse_player
     ==========
     process_options(options)
     constructor(options)
     init(options)
       _init_play_video_file()
     download_video_file(url, cb)
     ms_reset()
  */
  var mse_player_class = function(options) {
    var t = this;
    t.constructor(options);
    return t;
  };
  {
    // ----------------------------------------------------------------------------
    mse_player_class.prototype.process_options = function(options) {
      var t = this, d = t.d;
      if (options==null)  options = {};
        if (options.video==null)                        { if (d.video==void(0)) { options.video = document.getElementById('video_player'); } else { delete options.video; }}
        if (options.mp4box==null)                       { if (d.mp4box==void(0))     { options.mp4box = new MP4Box(false); } else { delete options.mp4box; }}
        if (options.downloader==null)                   { if (d.downloader==void(0))     { options.downloader = new Downloader(); } else { delete options.downloader; }}
        if (options.downloader_chunk_size_bytes==null)  { if (d.downloader_chunk_size_bytes==void(0))     { options.downloader_chunk_size_bytes = 1024 * 1024; } else { delete options.downloader_chunk_size_bytes; }}
        if (options.src==null)                          { if (d.src==void(0))        { options.src = null; } else { delete options.src; }}
        
      if (options.video!=null) {
        var video = options.video;
        video.addEventListener('seeking', function(e) {
          var i, start, end;
          var seek_info;
          if (video.lastSeekTime !== video.currentTime) {
            for (i = 0; i < video.buffered.length; i++) {
              start = video.buffered.start(i);
              end = video.buffered.end(i);
              if (video.currentTime >= start && video.currentTime <= end) {
                return;
              }
            }
            /* Chrome fires twice the seeking event with the same value */
            console.info('Application', 'Seeking called to video time '+Log.getDurationString(video.currentTime));
            downloader.stop();
            //resetCues();
            seek_info = mp4box.seek(video.currentTime, true);
            downloader.setChunkStart(seek_info.offset);
            downloader.resume();
            video.lastSeekTime = video.currentTime;
          }
        });
        video.addEventListener('error', function(e) {
          console.error('Media Element error', e);
        });
      }        
        
      return options;
    };
    // ----------------------------------------------------------------------------    
    mse_player_class.prototype.constructor = function(options) {
      var t = this;

      // Instance data map:
      // ==================
      t.d = {
        // It will have all the properties included in 'options' here, plus:
        feeding_mechanism: null,  // download | websockets
        video: null,              // The <video> tag elem
        mp4box: null,             // The mp4box instance
        mp4box_info: null,        // The info object returned by mp4box with details of the video file (tracks, codec, etc)
        downloader: null,         // A downloader module
        ms: null                  // MediaSource  (with added custom props like:  pending_sbs_initial_segments_to_append | readyState)
      };

      // We process the passed options and store them in the data map.
      // NOTE: we do NOT call t.init(options) here as the init method is supposed to execute additional code in the future.
      options = t.process_options(options);    
      Object.assign(t.d, options);  
    };
    // ----------------------------------------------------------------------------
    mse_player_class.prototype.init = function(options) {
      var t = this, d = t.d;
      options = t.process_options(options);
      Object.assign(t.d, options);
      
      // Start video playback based on the specified src
      if (d.src==null)  return;
      if (d.src.match(/^wss?:\/\//)!=null) {
        // Websocket-based video stream
        d.feeding_mechanism = 'websockets';
      } else {
        // Video file
        d.feeding_mechanism = 'download';
        t._init_play_video_file();
      }
    };
    // ----------------------------------------------------------------------------
    mse_player_class.prototype._init_play_video_file = function() {
      var t = this, d = t.d;
      var mp4box = d.mp4box;
      var video = d.video;
      
      t.reset(function(err, data) {
        if (err!=null)  return;
        mp4box.onSegment = function (track_id, sb, buffer, sample_sequence_number) {
          sb.segment_sequence_number++;
          sb.pending_sb_segments_to_append.push({ track_id:track_id, buffer:buffer, sample_sequence_number:sample_sequence_number });
          console.info('Application','Received new segment for track '+track_id+' up to sample #'+sample_sequence_number+', segments pending append: '+sb.pending_sb_segments_to_append.length);
          sb.updateend(false, false);
        }
        
        mp4box.onReady = function(mp4box_info) {
          console.log('mp4box_info:',mp4box_info);
          var ms = video.ms || d.ms;
          d.mp4box_info = mp4box_info;
          
          // Set the movie duration. If we do not set the duration (e.g. the case of streams) the player will not let the user seek
          if (mp4box_info.isFragmented) {
            d.ms.duration = mp4box_info.fragment_duration/mp4box_info.timescale;
          } else {
            d.ms.duration = mp4box_info.duration/mp4box_info.timescale;
          }
          
          //t._download_video_file_stop();
          
          // Create a SourceBuffer per track and add it to the MediaSource instance
          // The 'track' arg is an object with the following props: { id, codec, kind, type, language, name }
          mp4box_info.tracks.map(function(track) {
            t._ms_add_track(track);
          });
          
          // Start mp4 file segmentation!
          // When we initiate the segmentation process, the function that starts it returns an array with the initial segments (one per track).
          // These initial segments contain valuable info for the SourceBuffers that are to handle them. If we do not pass these segments to the SourceBuffers we will get an error.
          // So noe we need to append initial track buffers to each SourceBuffer!
          var initial_segments = mp4box.initializeSegmentation(); // We indicate mp4box that we are ready to receive segments. Returns an array of objects containing tha track id, the sb (aka user), and the ArrayBuffer with the the initialization segment the track
          ms.pending_sbs_initial_segments_to_append = 0;
          for (var i = 0; i<initial_segments.length; i++) {
            var sb = initial_segments[i].user;  // This is the SourceBuffer instance that is associated to the track
            if (sb!=null) {
              console.info('MSE - SourceBuffer #'+sb.track_id, 'Appending initialization data');
              sb.appendBuffer(initial_segments[i].buffer);
              ms.pending_sbs_initial_segments_to_append++;
            }
          }

        };
        
        mp4box.start();
        
        t._download_video_file(d.src, function(err, data) {
          if (err!=null)  return;
        });
      });
    }
    // ----------------------------------------------------------------------------
    mse_player_class.prototype._download_video_file = function(url, cb) {
      var t = this, d = t.d;
      var mp4box = d.mp4box;
      var downloader = d.downloader;
      var chunk_size_bytes = d.downloader_chunk_size_bytes;
      var startDate = new Date();
      
      downloader.setCallback(
        function (response, end, error) { 
          var nextStart = 0;
          if (response) {
            nextStart = mp4box.appendBuffer(response); //nextStart += chunk_size_bytes;				
          }
          if (end) {
            console.log('Done reading file ('+downloader.totalLength+ ' bytes) in '+(new Date() - startDate)+' ms');
            mp4box.flush();
            cb && cb();
          } else {
            downloader.setChunkStart(nextStart); 
          }
          if (error) {
            t.reset();
            console.log('Download error!');
            cb && cb(error);
          }
        }
      );
      downloader.setInterval(10);
      downloader.setChunkSize(chunk_size_bytes);
      downloader.setUrl(url);
      downloader.start();
    };
    // ----------------------------------------------------------------------------
    mse_player_class.prototype._download_video_file_resume = function start() {
      var t = this, d = t.d;
      var mp4box = d.mp4box;
      var downloader = d.downloader;
      var chunk_size_bytes = d.downloader_chunk_size_bytes;
      var offset; try { offset = mp4box.seek(0, true).offset; } catch(e) {}
      if (offset!=null)  downloader.setChunkStart(mp4box.seek(0, true).offset);
      downloader.setChunkSize(chunk_size_bytes);
      downloader.setInterval(10);
      mp4box.start();
      downloader.resume();
      //d.video.autoplay = true;
      d.video.play();
    };
    // ----------------------------------------------------------------------------
    mse_player_class.prototype._download_video_file_stop = function stop() {
      var t = this, d = t.d;
      var downloader = d.downloader;
      if (!downloader.isStopped()) {
        downloader.stop();
      }
    };
    // ----------------------------------------------------------------------------
    mse_player_class.prototype.reset = function(cb) {
      var t = this, d = t.d;
      
      var ncbs_local = 0, cb_local_data = [];
      var cb_local = function(err, data) {
        if (ncbs_local==null) return;
        ncbs_local++; cb_local_data.push(data);
        if (err!=null)           { ncbs_local = null; cb && cb(err, null); }
        else if (ncbs_local>=1)  { cb && cb(err, cb_local_data); }
      }
      
      t._download_video_file_stop();
      d.downloader.reset();
      t._reset_ms(cb_local);
    };
    // ----------------------------------------------------------------------------
    mse_player_class.prototype._reset_ms = function(cb) {
      var t = this, d = t.d;
      var video = d.video;
      var ms;

      d.ms = video.ms = null;
      
      ms = new MediaSource();
        ms.addEventListener('sourceopen', function(e) {
          var ms = e.target;
          console.info('MSE', 'Source opened');
          console.debug('MSE', ms);
          cb && cb();
        });
        ms.addEventListener('sourceclose', function(e) {
          var ms = e.target;
          if (ms.video.error) {
            console.error('MSE', 'Source closed, video error: '+ ms.video.error.code);		
          } else {
            console.info('MSE', 'Source closed, no error');
          }
        });

      ms.video = video;
      video.ms = ms;
      video.src = window.URL.createObjectURL(ms);

      /* TODO: cannot remove Text tracks! Turning them off for now*/
      for (var i = 0; i < video.textTracks.length; i++) {
        var tt = video.textTracks[i];
        tt.mode = 'disabled';
      }
      
      d.ms = ms;
    };
    // ----------------------------------------------------------------------------
    // Create a SourceBuffer per track and add it to the MediaSource instance
    // The 'track' arg is an object with the following props: { id, codec, kind, type, language, name }
    mse_player_class.prototype._ms_add_track = function(track) {
      var t = this, d = t.d;
      var ms = d.ms;
      var video = d.video;
      var mp4box = d.mp4box;
      var sb;
      var track_id = track.id;
      var codec = track.codec;
      var mime = track.type+'/mp4; codecs=\"'+codec+'\"';
      var kind = track.kind;
      var track_default;
      var track_default_supported = (window.TrackDefault!==void(0));
      var html5_track_kind = '';
      
      // Get html5_track_kind
      if (codec == 'wvtt') {
        if (!kind.schemeURI.startsWith('urn:gpac:')) {
          html5_track_kind = 'subtitles';
        } else {
          html5_track_kind = 'metadata';
        }
      } else {
        if (kind && kind.schemeURI==='urn:w3c:html5:kind') {
          html5_track_kind = kind.value || '';
        } 
      }
      
      // Create TrackDefault instance
      if (track_default_supported) {
        if (track.type==='video' || track.type==='audio') {
          track_default = new TrackDefault(track.type, track.language, track.name, [ html5_track_kind ], track_id);
        } else {
          track_default = new TrackDefault('text', track.language, track.name, [ html5_track_kind ], track_id);
        }
      }
      
      // Create SourceBuffer for this track and attach it to the MediaSource instance
      if (MediaSource.isTypeSupported(mime)) {
        try {
          console.info('MSE - SourceBuffer #'+track_id,'Creation with type ['+mime+']');
          
          /*  Each sb (SourceBuffer) object will have the following structure:
              ----------------------------------------------------------------
              sb
                <SourceBuffer> properties
                ms                   // This is the MediaSource the SourceBuffer is attached to
                track_id             // e.g.  1 | 2 | 3 ...
                track_defaults
                segment_sequence_number
                sample_sequence_number
                pending_sb_segments_to_append[]
                  track_id
                  buffer
                  sample_sequence_number
                buffered
                updating
                <Events>
                  updateend          
                  error
                <Event handlers>
                  on_updateend_first_one
                  on_updateend
          */
          sb = ms.addSourceBuffer(mime);
            sb.ms = ms;
            sb.track_id = track_id;
            sb.track_defaults = null;
              if (track_default_supported) {
                sb.track_defaults = new TrackDefaultList([track_default]);
              }
            sb.addEventListener('error', function(e) {
              debugger;
              console.error('MSE SourceBuffer #'+track_id, e);
            });
            sb.segment_sequence_number = 0;
            sb.sample_sequence_number = 0;
            sb.pending_sb_segments_to_append = [];
          
            sb.update_buffered_string = t._sb_update_buffered_string.bind(sb, t);
            sb.updateend              = t._sb_updateend.bind(sb, t);
            sb.on_updateend           = t._sb_on_updateend.bind(sb, t, false, true);
            sb.on_updateend_first_one = t._sb_on_updateend_first_one.bind(sb, t);

            sb.addEventListener('updateend', sb.on_updateend_first_one);
            //sb.addEventListener('updateend', sb.on_updateend);
            
          if (d.feeding_mechanism=='download') {
            mp4box.setSegmentOptions(track_id, sb, { nbSamples:20 } );
          }
          
        } catch (e) {
          console.error('MSE - SourceBuffer #'+track_id,'Cannot create buffer with type ['+mime+']' + e);
        }
      } else {
        console.warn('MSE', 'MIME type ['+mime+'] not supported for creation of a SourceBuffer for track id '+track_id);
      }      
      
      return sb;
    };
    // ----------------------------------------------------------------------------
    mse_player_class.prototype._sb_update_buffered_string = function(mse_player, str) {
      var sb = this;
      var rangeString;
      if (sb.ms.readyState==='open') {
        rangeString = Log.printRanges(sb.buffered);
        console.info('MSE - SourceBuffer #'+sb.track_id, str+', updating:'+sb.updating+', currentTime:'+Log.getDurationString(mse_player.d.video.currentTime, 1)+', buffered:'+rangeString+', pending:'+sb.pending_sb_segments_to_append.length);
      }
    };
    // ----------------------------------------------------------------------------
    mse_player_class.prototype._sb_updateend = function(mse_player, isInit, isEndOfAppend, e) {
      var sb = this;  // equals to e.target
      var mp4box = mse_player.d.mp4box;
      var video = mse_player.d.video;
        //if (video.paused==true)  video.play();
      if (isEndOfAppend===true) {
        if (isInit!==true) {
          mse_player._sb_update_buffered_string.call(sb, mse_player, 'Update ended');
        }
        if (sb.sample_sequence_number) {
          if (mse_player.d.feeding_mechanism=='download')  mp4box.releaseUsedSamples(sb.track_id, sb.sample_sequence_number);
          delete sb.sample_sequence_number;
        }
      }
      if (sb.ms.readyState==='open' && sb.updating===false && sb.pending_sb_segments_to_append.length>0) {
        var pending_sb_segment_to_append = sb.pending_sb_segments_to_append.shift();
        console.info('MSE - SourceBuffer #'+sb.track_id, 'Appending new buffer, pending:'+sb.pending_sb_segments_to_append.length);
        sb.sample_sequence_number = pending_sb_segment_to_append.sample_sequence_number;
        sb.appendBuffer(pending_sb_segment_to_append.buffer);
      }
    };
    // ----------------------------------------------------------------------------
    mse_player_class.prototype._sb_on_updateend = function(mse_player, isInit, isEndOfAppend, e) {
      var sb = this;  // equals to e.target
      return mse_player._sb_updateend.call(sb, mse_player, isInit, isEndOfAppend, e);
    };
    // ----------------------------------------------------------------------------
    mse_player_class.prototype._sb_on_updateend_first_one = function(mse_player, e) {
      var sb = this;  // equals to e.target
      if (sb.ms.readyState==='open') {
        mse_player._sb_update_buffered_string.call(sb, mse_player, 'Initial segment append done');
        sb.sample_sequence_number = 0;
        sb.removeEventListener('updateend', sb.on_updateend_first_one);
        sb.addEventListener('updateend', sb.on_updateend);
        /* In case there are already pending buffers we call onUpdateEnd to start appending them*/
        sb.updateend(true, true);
        sb.ms.pending_sbs_initial_segments_to_append--;
        if (sb.ms.pending_sbs_initial_segments_to_append===0 && mse_player.d.feeding_mechanism=='download')  {
          mse_player._download_video_file_resume();
        }
        
      }
    };
    // ----------------------------------------------------------------------------    
    // End of mse_player_class
  }
  // ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~






  // Create an mse player instance and init it!
  window.mse_player = new mse_player_class({
    video: document.getElementById('video_player'),
    src: '/media/' +
      //'small.unfragmented.mp4' +
      'globe.unfragmented.mp4' +
      ''
  });
  window.mse_player.init();

  
})();