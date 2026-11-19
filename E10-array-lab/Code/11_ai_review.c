#include <stdio.h>

int main(void)
{
    int a[5];
    int n, i;
    int sum = 0;
    int max = 0, min = 100, pass = 0;
    int key, pos = 0, found = 0;

    scanf("%d", &n);
    for (i = 0; i < n; i++) {
        scanf("%d", &a[i]);
    }

    for (i = 0; i < n; i++) {
        sum += a[i];
        if (a[i] > max) max = a[i];
        if (a[i] < min) min = a[i];
        if (a[i] > 60)  pass++;
    }

    scanf("%d", &key);
    for (i = 0; i < n; i++) {
        if (a[i] == key) {
            pos = i;
            found = 1;
        }
    }
    if (found) {
        printf("找到 %d，pos = %d\n", key, pos);
    } else {
        printf("没找到 %d，pos = %d\n", key, pos);
    }

    printf("总分 = %d\n", sum);
    printf("平均 = %.2f\n", (double)sum / n);
    printf("最高分 = %d\n", max);
    printf("最低分 = %d\n", min);
    printf("及格人数 = %d\n", pass);

    return 0;
}
