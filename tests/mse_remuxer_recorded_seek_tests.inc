void test_recorded_seek_landing_splices_matching_av_before_output() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    constexpr std::int64_t source_boundary_us = 159380311;
    constexpr std::int64_t timestamp_offset_us = -821944;
    remuxer.setTimestampOffset(timestamp_offset_us);
    remuxer.setOutputEnabled(false);

    remuxer.prepareMseRecordedSeekLanding(source_boundary_us);
    check(sink.events.empty(),
          "Recorded landing splice escaped without an active seek generation");

    remuxer.beginMseRecordedSeek();
    remuxer.prepareMseRecordedSeekLanding(source_boundary_us);
    check(sink.events == std::vector<std::string>{"video-splice", "splice"},
          "Recorded landing did not publish one matching video/audio splice pair");
    check(sink.video_splices.size() == 1 && sink.splices.size() == 1 &&
              sink.video_splices.front().presentation_time_us == source_boundary_us &&
              sink.splices.front().presentation_time_us == source_boundary_us &&
              sink.video_splices.front().timestamp_offset_us == timestamp_offset_us &&
              sink.splices.front().timestamp_offset_us == timestamp_offset_us,
          "Recorded landing splice pair lost its source RAP or timestamp mapping");
}

void test_recorded_seek_landing_discards_audio_before_video_boundary() {
    TestSink sink;
    tlvdemux::MseRemuxer remuxer(sink);
    constexpr std::int64_t source_boundary_us = 42666;
    remuxer.selectTrack(tlvdemux::TrackKind::Video, 2);
    remuxer.selectTrack(tlvdemux::TrackKind::Audio, 1);
    remuxer.setOutputEnabled(false);
    remuxer.beginMseRecordedSeek();
    remuxer.prepareMseRecordedSeekLanding(source_boundary_us);
    remuxer.setOutputEnabled(true);
    remuxer.push(hevc_unit(2, source_boundary_us, source_boundary_us, true, true));
    remuxer.push(audio_unit(1, 0));
    remuxer.push(audio_unit(1, 1024));
    remuxer.push(audio_unit(1, 2048));
    remuxer.push(audio_unit(1, 3072));
    remuxer.flushRecordedSeekAudio();

    const auto audio = std::find_if(
        sink.segments.begin(), sink.segments.end(),
        [](const tlvdemux::MseMediaSegment& segment) {
            return segment.type == "audio";
        });
    check(audio != sink.segments.end() &&
              audio->start_time_us >= source_boundary_us,
          "Recorded landing retained AAC before its video RAP boundary");
}
