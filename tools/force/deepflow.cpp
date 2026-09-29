// Browser wrapper for the unmodified OpenCV 4.12 DeepFlow algorithm.
#include <opencv2/core.hpp>
#include <opencv2/imgproc.hpp>
#include <opencv2/video.hpp>
#include <algorithm>
#include <cmath>
#include <string>
#include <vector>
namespace cv { namespace optflow { cv::Ptr<cv::DenseOpticalFlow> createOptFlow_DeepFlow(); } }
namespace {
cv::Mat reference, referenceSmall;
cv::Ptr<cv::CLAHE> clahe;
cv::Ptr<cv::DenseOpticalFlow> flow;
std::vector<float> input(640 * 360 * 3);
std::string error;
cv::Mat gray(const unsigned char* rgba, int width, int height) {
    cv::Mat source(height, width, CV_8UC4, const_cast<unsigned char*>(rgba)), resized, result;
    if (width != 640 || height != 360) cv::resize(source, resized, {640,360});
    else resized = source;
    cv::cvtColor(resized, result, cv::COLOR_RGBA2GRAY);
    return result;
}
cv::Mat small(const cv::Mat& image) {
    cv::Mat enhanced, result;
    clahe->apply(image, enhanced);
    cv::resize(enhanced, result, {224,126}, 0, 0, cv::INTER_AREA);
    return result;
}
}
extern "C" {
const char* force_error() { return error.c_str(); }
int force_reset(const unsigned char* rgba, int width, int height) {
    try {
        cv::setNumThreads(1);
        clahe = cv::createCLAHE(2.0, {8,8});
        flow = cv::optflow::createOptFlow_DeepFlow();
        reference = gray(rgba, width, height);
        referenceSmall = small(reference);
        error.clear(); return 1;
    } catch (const std::exception& e) { error = e.what(); return 0; }
}
float* force_input(const unsigned char* rgba, int width, int height) {
    try {
        cv::Mat current = gray(rgba, width, height), fieldSmall, field;
        flow->calc(referenceSmall, small(current), fieldSmall);
        cv::resize(fieldSmall, field, {640,360}, 0, 0, cv::INTER_LINEAR);
        const float scale = static_cast<float>(1.0 / 0.35);
        const int pixels = 640 * 360;
        for (int i = 0; i < pixels; ++i) {
            input[i] = field.ptr<cv::Vec2f>()[i][0] * scale;
            input[pixels+i] = field.ptr<cv::Vec2f>()[i][1] * scale;
            const float diff = float(int(current.data[i]) - int(reference.data[i])) / float(std::max(1,int(reference.data[i])));
            input[2*pixels+i] = std::nearbyint(diff * 100.f) / 100.f;
        }
        error.clear(); return input.data();
    } catch (const std::exception& e) { error = e.what(); return nullptr; }
}
}
