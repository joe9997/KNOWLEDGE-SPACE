#include <stdio.h>

int main(void)
{
    int a[50];
    int n, i;
    int c1 = 0, c2 = 0, c3 = 0;
    int max;

    scanf("%d", &n);
    for (i = 0; i < n; i++) {
        scanf("%d", &a[i]);
    }

    max = a[0];
    for (i = 0; i < n; i++) {
        if (a[i] >= 0 && a[i] <= 59) {
            c1++;
        } else if (a[i] >= 60 && a[i] <= 79) {
            c2++;
        } else if (a[i] >= 80 && a[i] <= 100) {
            c3++;
        }
        if (a[i] > max) {
            max = a[i];
        }
    }

    printf("0-59 分：%d 人\n", c1);
    printf("60-79 分：%d 人\n", c2);
    printf("80-100 分：%d 人\n", c3);
    if (max >= 80) {
        printf("最高分 %d，落在 80-100 分\n", max);
    } else if (max >= 60) {
        printf("最高分 %d，落在 60-79 分\n", max);
    } else {
        printf("最高分 %d，落在 0-59 分\n", max);
    }
    printf("合计 %d 人\n", c1 + c2 + c3);

    return 0;
}
